import { useEffect, useState } from 'react';
import { useToast, useConfirmDialog } from '../../../shared/ui';

/**
 * 本地知识库 Obsidian Vault 面板（P2/P3 改造的 UI 入口）。
 * - 导出：把本地库文档镜像为 Vault 的 content.md（含 YAML frontmatter），单向，不污染本地库。
 * - 写回：仅手动触发，把 Vault 里改动的文档正文写回本地库（不重分析），再由现有「同步」上推服务器。
 * 对应隐患 H5/H6：frontmatter 只加在导出层；vault 副本与本地库隔离；回写服务器需手动确认。
 */
export default function ObsidianVaultPanel() {
  const { showToast } = useToast();
  const { confirm } = useConfirmDialog();
  const [vaultPath, setVaultPathState] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void window.yibiao?.kbVault
      .getPath()
      .then((res) => {
        if (res?.success && res.data?.vaultPath) setVaultPathState(res.data.vaultPath);
      })
      .catch(() => {});
  }, []);

  async function handleExport() {
    setBusy(true);
    try {
      const res = await window.yibiao?.kbVault.export();
      if (!res?.success) throw new Error(res?.error || '导出失败');
      showToast(
        `已导出 ${res.exported ?? 0} 个文档到 Obsidian Vault（跳过 ${res.skipped ?? 0} 个空文档）\n路径：${res.vaultPath}`,
        'success',
      );
      // 导出成功后自动调起 Obsidian 定位到 Vault（没装则退化为文件管理器）。
      await handleOpen();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '导出失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    try {
      const res = await window.yibiao?.kbVault.open();
      if (!res?.success) throw new Error(res?.error || '打开失败');
      if (res.openedWith === 'explorer') {
        showToast('未检测到 Obsidian，已用文件管理器打开 Vault 文件夹（如已安装 Obsidian 可直接打开该文件夹）', 'info');
      } else {
        showToast('已尝试用 Obsidian 打开 Vault', 'success');
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '打开 Vault 失败', 'error');
    }
  }

  async function handleImport() {
    const ok = await confirm({
      title: '从 Obsidian 写回本地库',
      message:
        '将把 Vault 中你修改过的文档内容写回本地知识库（仅覆盖正文，不重分析）。写回后请用现有「同步」功能上推到服务器。确定继续？',
      confirmText: '写回',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.yibiao?.kbVault.import();
      if (!res?.success) throw new Error(res?.error || '写回失败');
      const n = res.changed?.length ?? 0;
      showToast(n ? `已写回 ${n} 个文档到本地库` : '没有检测到改动，未做任何写回', n ? 'success' : 'info');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '写回失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetPath() {
    const res = await window.yibiao?.kbVault.setPath(vaultPath);
    if (res?.success && res.data?.vaultPath) {
      setVaultPathState(res.data.vaultPath);
      showToast('Vault 路径已更新', 'success');
    }
  }

  return (
    <div
      className="obsidian-vault-panel"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 50,
        width: 300,
        background: 'var(--surface, #fff)',
        border: '1px solid #ddd',
        borderRadius: 10,
        padding: 12,
        boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
      }}
    >
      {!open ? (
        <button type="button" className="secondary-action" onClick={() => setOpen(true)}>
          Obsidian Vault
        </button>
      ) : (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Obsidian Vault</strong>
            <button type="button" className="secondary-action" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px' }}>
            把本地知识库镜像为可编辑的 Markdown Vault；改完手动写回本地库，再经同步上推服务器。
          </p>
          <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Vault 路径</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              value={vaultPath}
              onChange={(e) => setVaultPathState(e.target.value)}
              style={{ flex: 1, fontSize: 12, padding: '4px 6px' }}
            />
            <button type="button" className="secondary-action" onClick={() => void handleSetPath()}>
              设置
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="secondary-action" disabled={busy} onClick={() => void handleExport()}>
              导出
            </button>
            <button type="button" className="secondary-action" disabled={busy} onClick={() => void handleImport()}>
              写回
            </button>
            <button type="button" className="secondary-action" onClick={() => void handleOpen()}>
              打开
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
