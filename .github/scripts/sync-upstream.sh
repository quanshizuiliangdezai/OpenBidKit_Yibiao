#!/usr/bin/env bash
# sync-upstream.sh — Fork 自动同步上游脚本
# 功能：fetch → merge → 冲突处理(DU/UU/UD) → 恢复我们的修改 → tsc校验 → push + tag
# 由 GitHub Actions 调用，7x24 服务器执行，不依赖本地电脑
set -euo pipefail

# ========== 配置 ==========
UPSTREAM_REPO="https://github.com/FB208/OpenBidKit_Yibiao.git"
ORIGIN_REPO="quanshizuiliangdezai/OpenBidKit_Yibiao"
TAG_PREFIX="上游更新"

# 我们的 10 处修改：路径 + marker（证明修改存在的唯一字符串）
OUR_MODS=(
  "client/electron/services/syncService.cjs|createSyncService"
  "client/electron/ipc/syncIpc.cjs|registerSyncIpc"
  "client/src/features/settings/pages/AccountPage.tsx|AccountPage"
  "client/electron/preload.cjs|sync: {"
  "client/src/shared/types/ipc.ts|SyncPushResult"
  "client/src/features/knowledge-base/pages/KnowledgeBasePage.tsx|syncToTeam"
  "client/electron/services/configStore.cjs|normalizeAccount"
  "client/src/app/menuConfig.ts|id: 'account',"
  "client/src/components/Sidebar.tsx|account: UserIcon,"
  "client/electron/ipc/index.cjs|createSyncService"
)

# DU 冲突：fork 删除的路径（保留删除，不从 upstream 恢复）
DU_KEEP_DELETED=("使用说明/" "yibiao-user-manual")

# ========== 日志 ==========
log()  { echo -e "\033[32m[$(date '+%H:%M:%S')]\033[0m $1"; }
warn() { echo -e "\033[33m[$(date '+%H:%M:%S')]\033[0m $1"; }
err()  { echo -e "\033[31m[$(date '+%H:%M:%S')]\033[0m $1"; }

# ========== 0. 前置检查 ==========
if [ -z "${GITHUB_TOKEN:-}" ]; then
  err "GITHUB_TOKEN 未设置！请检查 workflow secrets 配置。"
  exit 1
fi

# ========== 1. 记录合并前 HEAD ==========
PRE_MERGE_HEAD=$(git rev-parse HEAD)
log "Pre-merge HEAD: $PRE_MERGE_HEAD"

# ========== 2. 添加 upstream 并 fetch ==========
log "Adding upstream remote..."
git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
# 只 fetch 上游分支（含 main），不要 --tags：fork 已有部分同名 tag 与上游指向不同
# commit，--tags 会因 "would clobber existing tag" 失败，配合 set -e 直接退出整个同步。
git fetch upstream '+refs/heads/*:refs/remotes/upstream/*' --no-tags

# ========== 3. 检查落后情况 ==========
BEHIND=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo "0")
log "Behind upstream by $BEHIND commits"

if [ "$BEHIND" = "0" ]; then
  log "Already up to date. Nothing to do."
  echo "## Upstream Sync - Skipped" >> "$GITHUB_STEP_SUMMARY"
  echo "Already up to date, no changes needed." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# ========== 3b. 破坏性上游检测（保护 fork 核心功能） ==========
# 若上游领先提交删除了 fork 关键文件（知识库QA/同步/ConfirmDialog/CI脚本/部署代码等），
# 说明上游在做破坏性重构，直接跳过同步，避免把 fork 功能清零。
# 注意：比较基准必须是「fork 与上游的共同祖先」，不能用 HEAD。
#   原因：fork 有大量上游从未有过的独有文件（yibiao-kb-worker/kb-server/sync-server/
#   CI脚本/kbQaSession/ConfirmDialog 等）。若用 HEAD..upstream/main，这些 fork 独有文件
#   会被 diff --diff-filter=D 误判为「上游删除」→ 必然命中 FORK_CRITICAL → 误杀正常同步。
#   用 `git merge-base HEAD upstream/main` 取共同祖先后，只有上游【相对基线真实删除】的
#   文件才会被检出，才能正确区分「破坏性重构」与「正常增量（含 fork 独有文件）」。
FORK_CRITICAL=(
  "client/electron/services/syncService.cjs"
  "client/src/shared/ui/ConfirmDialogProvider.tsx"
  "client/electron/services/kbQaSessionService.cjs"
  "client/src/features/knowledge-base/pages/KbQaPage.tsx"
  ".github/scripts/sync-upstream.sh"
  ".github/workflows/auto-build.yml"
  "server/yibiao-kb-worker/worker.cjs"
  "kb-server/kb_db.py"
  "sync-server/server.py"
)
MERGE_BASE=$(git merge-base HEAD upstream/main 2>/dev/null || echo "HEAD")
DELETED_CRITICAL=$(git diff --name-only "$MERGE_BASE"..upstream/main --diff-filter=D 2>/dev/null || true)
DESTRUCTIVE=0
for crit in "${FORK_CRITICAL[@]}"; do
  if echo "$DELETED_CRITICAL" | grep -qx "$crit"; then
    warn "检测到上游删除了 fork 关键文件: $crit —— 跳过本次同步以保护 fork 功能。"
    DESTRUCTIVE=1
  fi
done
if [ "$DESTRUCTIVE" -eq 1 ]; then
  err "上游为破坏性重构，已跳过自动同步。请人工评估后再决定是否合并。"
  echo "## Upstream Sync - Skipped (destructive upstream change detected)" >> "$GITHUB_STEP_SUMMARY"
  echo "上游删除了 fork 关键文件，自动同步已跳过以避免破坏 fork 功能。请人工处理。" >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# ========== 4. Merge ==========
# 注意：脚本顶部 set -e 下，若 merge 冲突（退出码非0），命令替换会直接终止脚本。
# 这里用 set +e 包裹，既避免异常退出，又能拿到真实退出码；否则 || true 会吞掉退出码，
# 导致下方冲突处理分支（4a-4e）永不执行，残留的 conflict marker 会让后续 tsc 失败。
set +e
git merge upstream/main --no-edit > /tmp/sync_merge.log 2>&1
MERGE_EXIT=$?
set -e
MERGE_OUTPUT=$(cat /tmp/sync_merge.log)

if echo "$MERGE_OUTPUT" | grep -q "Already up to date"; then
  log "Already up to date after fetch."
  exit 0
fi

if [ $MERGE_EXIT -ne 0 ]; then
  log "Merge conflicts detected. Resolving..."

  # --- 4a. DU 冲突（我们删除，上游修改）→ git rm 保留删除 ---
  DU_FILES=$(git diff --name-only --diff-filter=DU 2>/dev/null || true)
  if [ -n "$DU_FILES" ]; then
    log "Resolving DU conflicts (keep fork's version unless in keep-deleted list)..."
    echo "$DU_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      # 默认保留 fork 版本：git 常因 upstream rename 把“我们修改、上游删除”误判为 DU，
      # 无脑 git rm 会丢掉 fork 专属改动（如 SettingsPage.tsx），导致 import 失效、tsc 失败。
      # 仅 DU_KEEP_DELETED 列表里的（fork 主动删除的目录）才真正删除。
      SHOULD_DELETE=false
      for pattern in "${DU_KEEP_DELETED[@]}"; do
        if [[ "$f" == *"$pattern"* ]]; then
          SHOULD_DELETE=true
          break
        fi
      done
      if [ "$SHOULD_DELETE" = true ]; then
        git rm "$f" 2>/dev/null && log "  [DU→rm] $f" || log "  [DU→rm-skip] $f"
      else
        # 默认保留 fork 版本：若 stage 2（ours）存在则 checkout 恢复；
        # 若不存在（ours 实际是“删除”，被 git 误判为 DU）则保持删除，
        # 二者都不能因失败而触发 set -e 退出整个同步。
        if git checkout --ours "$f" 2>/dev/null; then
          git add "$f" && log "  [DU→ours] $f"
        else
          git rm -f "$f" 2>/dev/null || true
          log "  [DU→keep-ours-deleted] $f (stage2 missing, keeping deletion)"
        fi
      fi
    done
  fi

  # --- 4b. UD 冲突（我们修改，上游删除）→ 保留我们的版本 ---
  UD_FILES=$(git diff --name-only --diff-filter=UD 2>/dev/null || true)
  if [ -n "$UD_FILES" ]; then
    log "Resolving UD conflicts (keep our version)..."
    echo "$UD_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      # 优先 checkout --ours 恢复（stage 2 存在时成功）；
      # 若 stage 2 不存在（我们这边其实是“删除”，被 git 误判为 UD，
      # 如 sync-atomgit-code.yml 在 fork 已删除但上游修改），
      # 则保持删除状态（git rm），既符合“保留我们的版本”的意图，
      # 也避免 `git checkout --ours` 失败触发 set -e 直接退出整个同步。
      if git checkout --ours "$f" 2>/dev/null; then
        git add "$f" && log "  [UD→ours] $f"
      else
        git rm -f "$f" 2>/dev/null || true
        log "  [UD→keep-deleted] $f (stage2 missing, keeping deletion)"
      fi
    done
  fi

  # --- 4c. UU 冲突（双方都修改）→ 优先保留 fork 版本 ---
  # 说明：fork 在设置页/类型/ipc 上有大量专属定制（KB问答 KbQa*、agentRuntime、
  # 模型配置侧边栏、向导、技术方案等），不能让上游覆盖；且旧版“双保留”会把两份整文件
  # 拼接导致 tsc 失败、坏代码被 push。故 UU 一律取 fork 版本（--ours），仅在不冲突的
  # 文件中自动吸收上游改动。代价：暂不吸收上游对 settings 类型的重构（fork 并不需要）。
  UU_FILES=$(git diff --name-only --diff-filter=UU 2>/dev/null || true)
  if [ -n "$UU_FILES" ]; then
    log "Resolving UU conflicts (prefer fork version)..."
    echo "$UU_FILES" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      if git checkout --ours "$f" 2>/dev/null; then
        git add "$f" && log "  [UU→ours] $f"
      else
        git rm -f "$f" 2>/dev/null || true
        log "  [UU→keep-deleted] $f (stage2 missing)"
      fi
    done
  fi

  # --- 4d. 检查是否还有未解决冲突 ---
  REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    err "Unresolved conflicts remain:"
    echo "$REMAINING"
    git merge --abort
    exit 1
  fi

  # --- 4e. 完成 merge commit ---
  git commit --no-edit 2>/dev/null || log "Nothing to commit (merge auto-resolved)."
  log "All conflicts resolved, merge committed."
else
  log "Merge completed cleanly (no conflicts)."
fi

# ========== 4f. 强制保留 fork 深度定制文件（修复“每次同步 tsc 失败”） ==========
# 根因：上游常往共享类型/接口加必填项（如 SettingsPageState.developer_agent_monitor_auto_open）
# 或删除我们仍在用的字段（embeddingModelName / agentRuntime）。这类文件大多被 git
# **自动合并**进上游版本（非冲突，index 里没有 ours/theirs 舞台，`git checkout --ours`
# 对它无效，只会拿回已合并的上游版本）；而消费它的文件（SettingsPage.tsx）因冲突被 --ours
# 保留了我们的旧版 → 类型要求必填/字段不匹配 → tsc 必然失败 → 脚本 abort → 同步永远失败。
# 对策：对 fork 深度定制的文件，合并后一律从“合并前 HEAD”恢复我们的版本（即使已自动合并），
# 保证 fork 内部一致、我们的改动不丢。这些文件刻意不吸收上游改动（用户决策：保留自有版本，
# 后续如需上游改进再手动 cherry-pick）。注意用 `git show $PRE_MERGE_HEAD:` 而非 checkout --ours。
FORCE_OURS=(
  "client/src/features/settings/types.ts"
  "client/electron/services/outlineGenerationTask.cjs"
  "client/electron/services/outlineComplianceAudit.cjs"
  "client/src/features/technical-plan/pages/OutlineEditPage.tsx"
  "client/src/features/technical-plan/types.ts"
  "client/electron/services/pi/piRuntimeService.cjs"
  "client/electron/services/configStore.cjs"
  "client/src/features/settings/pages/SettingsPage.tsx"
)
log "Force-restoring fork-customized files from pre-merge HEAD (FORCE_OURS)..."
for f in "${FORCE_OURS[@]}"; do
  if git show "$PRE_MERGE_HEAD:$f" > "$f" 2>/dev/null; then
    git add "$f"
    log "  [FORCE-OURS] $f"
  else
    warn "  [FORCE-OURS-skip] $f not found in pre-merge HEAD (possibly new upstream file)"
  fi
done

# ========== 5. 恢复我们的修改 ==========
log "Checking our modifications..."
RESTORED=0
for entry in "${OUR_MODS[@]}"; do
  IFS='|' read -r filepath marker <<< "$entry"
  if [ ! -f "$filepath" ]; then
    # 文件不存在 → 从合并前 HEAD 恢复
    warn "  [MISSING] $filepath — restoring from pre-merge HEAD"
    mkdir -p "$(dirname "$filepath")"
    git show "$PRE_MERGE_HEAD:$filepath" > "$filepath" 2>/dev/null && {
      git add "$filepath"
      RESTORED=$((RESTORED + 1))
      log "  [RESTORED] $filepath"
    } || warn "  [FAILED] Could not restore $filepath"
  else
    # 文件存在但 marker 丢失 → 上游覆盖了我们的修改
    if ! grep -q "$marker" "$filepath" 2>/dev/null; then
      warn "  [OVERWRITTEN] $filepath — marker '$marker' not found, restoring from pre-merge HEAD"
      git show "$PRE_MERGE_HEAD:$filepath" > "$filepath" 2>/dev/null && {
        git add "$filepath"
        RESTORED=$((RESTORED + 1))
        log "  [RESTORED] $filepath"
      } || warn "  [FAILED] Could not restore $filepath"
    fi
  fi
done

if [ "$RESTORED" -gt 0 ]; then
  log "Restored $RESTORED files. Committing restore..."
  git commit --no-edit -m "chore: restore our modifications after upstream sync" 2>/dev/null || \
  git commit -m "chore: restore our modifications after upstream sync" 2>/dev/null || \
  log "No changes to commit after restore."
else
  log "All modifications intact, no restore needed."
fi

# ========== 5b. 安全网：扫描残留的 conflict marker ==========
# 若任何文件仍含 <<<<<<< / ======= / >>>>>>> 标记，说明冲突未解决干净，
# 直接回滚并退出，避免把坏代码 push 上去（之前就因此导致 tsc 失败）。
log "Scanning for leftover conflict markers..."
LEFTOVER=$(git grep -Il -E '^(<<<<<<<|=======|>>>>>>>)' -- './*' 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
  err "Leftover conflict markers found in:"
  echo "$LEFTOVER"
  err "Aborting sync to avoid pushing broken code."
  git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
  exit 1
fi
log "No leftover conflict markers."

# 关键文件存活检查：避免 fork 专属文件（如 SettingsPage.tsx）被误判为删除而丢失，
# 否则 AppRouter 的 import 会失效、tsc 报 “Cannot find module”。
for keep in client/src/features/settings/pages/SettingsPage.tsx; do
  if [ ! -f "$keep" ]; then
    err "CRITICAL: $keep is missing after merge (wrongly resolved as deletion). Aborting."
    git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
    exit 1
  else
    log "Kept fork file: $keep"
  fi
done
log "Changed files after merge: $(git diff --name-only HEAD | head -20 | tr '\n' ' ')"

# ========== 6. 校验 ==========
log "Running validation..."

# --- 6a. 安装依赖 + tsc --noEmit ---
log "Installing client dependencies for tsc..."
cd client
npm ci --production=false 2>/dev/null || npm install 2>/dev/null || {
  warn "npm install failed. Falling back to typescript-only check."
  npx -y typescript@latest --version 2>/dev/null || {
    err "Could not get typescript. Skipping tsc check (unsafe)."
    cd ..
    exit 1
  }
}

# 同步 lock：上游升级依赖（如 adm-zip CVE 修复）只改 package.json，merge 后
# package-lock.json 不会自动更新，会导致下游 auto-build 的 `npm ci` 因 lock/package.json
# 不一致而失败。上面 npm install 已就地修正 lock，必须提交，否则坏 lock 会被 push 出去。
ROOT_DIR="$(git rev-parse --show-toplevel)"
if ! git -C "$ROOT_DIR" diff --quiet "$ROOT_DIR/client/package-lock.json" 2>/dev/null; then
  git -C "$ROOT_DIR" add client/package-lock.json
  git -C "$ROOT_DIR" commit -m "chore: sync package-lock.json with package.json [skip ci]" 2>/dev/null \
    && log "  package-lock.json synced with package.json and committed." \
    || warn "  Failed to commit package-lock.json sync (auto-build's npm ci may fail)."
fi

TSC_RESULT=0
log "Running tsc --noEmit..."
npx tsc --noEmit 2>&1 || TSC_RESULT=$?
cd ..

if [ "$TSC_RESULT" -ne 0 ]; then
  err "tsc --noEmit FAILED! Merge is broken. Aborting."
  err "Run 'git merge --abort' or 'git reset --hard $PRE_MERGE_HEAD' locally to investigate."
  git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
  exit 1
fi
log "tsc --noEmit passed."

# --- 6b. node --check on modified .cjs files ---
MODIFIED_CJS=$(git diff --name-only "$PRE_MERGE_HEAD" HEAD -- '*.cjs' 2>/dev/null || true)
if [ -n "$MODIFIED_CJS" ]; then
  log "Checking modified .cjs files..."
  CHECK_FAIL=0
  echo "$MODIFIED_CJS" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -f "$f" ]; then
      node --check "$f" 2>&1 || {
        err "node --check FAILED for $f"
        CHECK_FAIL=1
      }
    fi
  done
  if [ "$CHECK_FAIL" -ne 0 ]; then
    err "node --check failed for some .cjs files. Aborting."
    git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
    exit 1
  fi
  log "All .cjs files passed node --check."
fi

# --- 6c. 关键功能存活检查 ---
log "Checking key function survival..."
KEYWORDS_MISSING=0
for kw in registerKbAuthIpc kbAuth kbTeam checkForUpdates; do
  if ! grep -rq "$kw" client/src/ client/electron/ 2>/dev/null; then
    warn "  Keyword not found: $kw"
    KEYWORDS_MISSING=$((KEYWORDS_MISSING + 1))
  fi
done

if [ "$KEYWORDS_MISSING" -gt 2 ]; then
  err "Too many key functions missing ($KEYWORDS_MISSING). Merge likely broke something. Aborting."
  git merge --abort 2>/dev/null || git reset --hard "$PRE_MERGE_HEAD"
  exit 1
fi
if [ "$KEYWORDS_MISSING" -gt 0 ]; then
  warn "$KEYWORDS_MISSING keywords not found (may be OK if refactored). Proceeding."
fi
log "Key function check done."

# ========== 7. Push ==========
log "Pushing to origin/main..."
PUSH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${ORIGIN_REPO}.git"
git push "$PUSH_URL" main

# ========== 8. Tag ==========
TAG_NAME="${TAG_PREFIX}-$(date '+%Y%m%d-%H%M')"
log "Creating tag: $TAG_NAME"
git tag "$TAG_NAME"
git push "$PUSH_URL" "$TAG_NAME"

# ========== 9. Summary ==========
log "Sync completed successfully!"
{
  echo "## Upstream Sync Completed"
  echo ""
  echo "- **Behind by**: $BEHIND commits"
  echo "- **Files restored**: $RESTORED"
  echo "- **Tag**: \`$TAG_NAME\`"
  echo "- **Pre-merge HEAD**: \`$PRE_MERGE_HEAD\`"
  echo "- **Post-merge HEAD**: \`$(git rev-parse HEAD)\`"
} >> "$GITHUB_STEP_SUMMARY"
