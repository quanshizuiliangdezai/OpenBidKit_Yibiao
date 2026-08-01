import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

/**
 * 强制释放 Radix Dialog 可能残留的全局副作用。
 *
 * Radix 打开弹窗时会：
 *  1. 通过 react-remove-scroll 在 <body> 上加 pointer-events:none / overflow:hidden / data-scroll-locked
 *  2. 通过 aria-hidden 库把 Portal 之外的兄弟节点标记 aria-hidden + data-aria-hidden
 *
 * 正常关闭时这些会被自动还原。但如果关闭的同一帧里调用方替换了整棵组件树
 * （例如退出登录后渲染登录页），还原操作会作用在已卸载的旧节点上，
 * 新挂载的页面就会残留 pointer-events:none，表现为「点不动、输入框打不了字」。
 */
export function releaseDialogSideEffects() {
  const body = document.body;
  if (!body) return;

  // 仍有其它弹层打开时不要清理，避免误伤
  if (document.querySelector('[role="dialog"][data-state="open"]')) return;

  if (body.style.pointerEvents === 'none') body.style.removeProperty('pointer-events');
  body.style.removeProperty('overflow');
  body.removeAttribute('data-scroll-locked');

  // aria-hidden 库会给它改过的节点打 data-aria-hidden 标记，据此精确回收
  document.querySelectorAll('[data-aria-hidden]').forEach((el) => {
    el.removeAttribute('aria-hidden');
    el.removeAttribute('data-aria-hidden');
  });
}

interface BaseDialogOptions {
  title: string;
  message?: string;
  confirmText?: string;
}

export interface ConfirmOptions extends BaseDialogOptions {
  cancelText?: string;
  variant?: 'danger' | 'primary' | 'info';
}

export interface PromptOptions extends BaseDialogOptions {
  defaultValue?: string;
  cancelText?: string;
  placeholder?: string;
}

export interface AlertOptions extends BaseDialogOptions {}

interface QueuedItem {
  type: 'confirm' | 'prompt' | 'alert';
  options: ConfirmOptions | PromptOptions | AlertOptions;
  resolve: (value: boolean | string | null | void) => void;
}

interface ConfirmDialogContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  alert: (options: AlertOptions) => Promise<void>;
}

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<QueuedItem | null>(null);
  const queueRef = useRef<QueuedItem[]>([]);
  const currentRef = useRef<QueuedItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');

  // 与 current 保持同步，供闭包内读取最新值，避免 enqueue 捕获到过期状态
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Provider 卸载时兜底清理，防止副作用残留
  useEffect(() => () => releaseDialogSideEffects(), []);

  const processNext = useCallback(() => {
    const next = queueRef.current.shift() || null;
    currentRef.current = next;
    setCurrent(next);
    if (next?.type === 'prompt') {
      setInputValue((next.options as PromptOptions).defaultValue || '');
    } else {
      setInputValue('');
    }
  }, []);

  const enqueue = useCallback(<T,>(type: QueuedItem['type'], options: ConfirmOptions | PromptOptions | AlertOptions): Promise<T> => {
    return new Promise<T>((resolve) => {
      queueRef.current.push({ type, options, resolve: resolve as (value: boolean | string | null | void) => void });
      if (!currentRef.current) {
        processNext();
      }
    });
  }, [processNext]);

  const confirm = useCallback((options: ConfirmOptions) => enqueue<boolean>('confirm', options), [enqueue]);
  const prompt = useCallback((options: PromptOptions) => enqueue<string | null>('prompt', options), [enqueue]);
  const alert = useCallback((options: AlertOptions) => enqueue<void>('alert', options), [enqueue]);

  const close = useCallback((result: boolean | string | null | void) => {
    const pending = currentRef.current;
    if (!pending) return;

    // 先关闭弹窗，让 Radix 走完卸载与全局副作用还原
    currentRef.current = null;
    setCurrent(null);

    // 关键：延后 resolve。若在此处同步 resolve，调用方（如退出登录）
    // 会在同一帧替换整棵组件树，Radix 的 pointer-events / aria-hidden 还原
    // 就会落在已卸载的旧节点上，导致新页面无法点击和输入。
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        releaseDialogSideEffects();
        pending.resolve(result);
        processNext();
      }, 0);
    });
  }, [processNext]);

  const handleConfirm = useCallback(() => {
    if (!current) return;
    if (current.type === 'prompt') {
      close(inputValue.trim());
    } else if (current.type === 'confirm') {
      close(true);
    } else {
      close(undefined);
    }
  }, [close, current, inputValue]);

  const handleCancel = useCallback(() => {
    if (!current) return;
    if (current.type === 'confirm') {
      close(false);
    } else if (current.type === 'prompt') {
      close(null);
    } else {
      close(undefined);
    }
  }, [close, current]);

  const value = useMemo<ConfirmDialogContextValue>(() => ({ confirm, prompt, alert }), [confirm, prompt, alert]);

  const isOpen = Boolean(current);
  const isPrompt = current?.type === 'prompt';
  const isAlert = current?.type === 'alert';
  const options = current?.options as ConfirmOptions & PromptOptions & AlertOptions;

  return (
    <ConfirmDialogContext.Provider value={value}>
      {children}
      <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleCancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="confirm-dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog-card"
            onCloseAutoFocus={(event) => event.preventDefault()}
            onOpenAutoFocus={() => {
              if (isPrompt) {
                // 延迟聚焦，确保 Dialog 已将内容渲染到 DOM
                requestAnimationFrame(() => {
                  inputRef.current?.focus();
                  const len = inputRef.current?.value.length || 0;
                  inputRef.current?.setSelectionRange(len, len);
                });
              }
            }}
          >
            <Dialog.Title className="confirm-dialog-title">{options?.title}</Dialog.Title>
            {options?.message && (
              <Dialog.Description className="confirm-dialog-description">
                {options.message}
              </Dialog.Description>
            )}
            {isPrompt && (
              <input
                ref={inputRef}
                type="text"
                className="confirm-dialog-input"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleConfirm();
                  }
                }}
                placeholder={(options as PromptOptions).placeholder || ''}
                autoComplete="off"
              />
            )}
            <div className="confirm-dialog-actions">
              {!isAlert && (
                <button type="button" className="secondary-action" onClick={handleCancel}>
                  {options?.cancelText || '取消'}
                </button>
              )}
              <button
                type="button"
                className={options?.variant === 'danger' ? 'danger-action' : 'primary-action'}
                onClick={handleConfirm}
                autoFocus={!isPrompt}
              >
                {options?.confirmText || (isAlert ? '知道了' : '确认')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog(): ConfirmDialogContextValue {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) {
    throw new Error('useConfirmDialog 必须在 ConfirmDialogProvider 内使用');
  }
  return ctx;
}
