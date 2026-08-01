import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');

  const processNext = useCallback(() => {
    const next = queueRef.current.shift() || null;
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
      if (!current) {
        processNext();
      }
    });
  }, [current, processNext]);

  const confirm = useCallback((options: ConfirmOptions) => enqueue<boolean>('confirm', options), [enqueue]);
  const prompt = useCallback((options: PromptOptions) => enqueue<string | null>('prompt', options), [enqueue]);
  const alert = useCallback((options: AlertOptions) => enqueue<void>('alert', options), [enqueue]);

  const close = useCallback((result: boolean | string | null | void) => {
    if (!current) return;
    current.resolve(result);
    setCurrent(null);
    // 使用 requestAnimationFrame 避免 Radix Dialog 关闭动画与下一条弹窗打开冲突
    requestAnimationFrame(() => {
      processNext();
    });
  }, [current, processNext]);

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
