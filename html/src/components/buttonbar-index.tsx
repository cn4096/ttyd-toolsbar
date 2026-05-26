import { h, Component } from 'preact';
import './buttonbar.scss';

const STORAGE_KEY = 'ttyd_custom_buttons';

export interface ButtonConfig {
    id: string;
    label: string;
    command: string;
}

interface Props {
    onSendCommand: (data: string | Uint8Array) => void;
}

interface State {
    buttons: ButtonConfig[];
    editMode: boolean;
    showEditor: boolean;
    editingButton: ButtonConfig | null;
    labelInput: string;
    commandInput: string;
    dragOverId: string | null;
    // touch-drag state
    touchDragId: string | null;
    touchOverId: string | null;
}

function loadButtons(): ButtonConfig[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw) as ButtonConfig[];
    } catch {
        /* ignore */
    }
    return [];
}

function saveButtons(buttons: ButtonConfig[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buttons));
    } catch {
        /* ignore */
    }
}

function genId(): string {
    return Math.random().toString(36).slice(2, 10);
}

/**
 * Parse command string into bytes to send.
 * Supports:
 *   \r  \n  \t  \\
 *   \x1b or \e  → ESC (0x1b)
 *   ^C  →  Ctrl+C  (0x03), ^A → 0x01, etc. (caret notation)
 *   \cC →  same as ^C
 *   Ctrl+C / ctrl+c  → 0x03  (human-friendly syntax)
 */
function ctrlChar(ch: string): string {
    if (ch === '@') return '\x00';
    const code = ch.toUpperCase().charCodeAt(0);
    // A-Z=65-90 -> ctrl 1-26; special: [=91->27, \=92->28, ]=93->29, ^=94->30, _=95->31
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    return ch;
}

function parseCommand(cmd: string): string {
    // Ctrl+C / ctrl+c syntax
    cmd = cmd.replace(/[Cc][Tt][Rr][Ll]\+([A-Za-z@^_])/g, (_m, ch: string) => ctrlChar(ch));
    // Also handle Ctrl+[ Ctrl+\ Ctrl+] via literal string check
    cmd = cmd.replace(/[Cc][Tt][Rr][Ll]\+\[/g, '\x1b');
    cmd = cmd.replace(/[Cc][Tt][Rr][Ll]\+\\/g, '\x1c');
    cmd = cmd.replace(/[Cc][Tt][Rr][Ll]\+\]/g, '\x1d');

    // \cX notation: \cC
    cmd = cmd.replace(/\\c([A-Za-z@^_])/g, (_m, ch: string) => ctrlChar(ch));

    // ^X caret notation: ^C
    cmd = cmd.replace(/\^([A-Za-z@^_])/g, (_m, ch: string) => {
        const result = ctrlChar(ch);
        return result.charCodeAt(0) < 32 ? result : '^' + ch;
    });

    // Standard escapes
    cmd = cmd
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\x1b/gi, '\x1b')
        .replace(/\\e/gi, '\x1b')
        .replace(/\\\\/g, '\\');

    return cmd;
}

export class ButtonBar extends Component<Props, State> {
    // touch drag helpers
    private touchStartY = 0;
    private touchStartX = 0;

    constructor(props: Props) {
        super(props);
        this.state = {
            buttons: loadButtons(),
            editMode: false,
            showEditor: false,
            editingButton: null,
            labelInput: '',
            commandInput: '',
            dragOverId: null,
            touchDragId: null,
            touchOverId: null,
        };
    }

    // ── Edit mode ──────────────────────────────────────────────
    private toggleEditMode = () => {
        this.setState(s => ({ editMode: !s.editMode }));
    };

    // ── Add / Edit dialog ──────────────────────────────────────
    private openAdd = () => {
        this.setState({ showEditor: true, editingButton: null, labelInput: '', commandInput: '' });
    };

    private openEdit = (btn: ButtonConfig, e: Event) => {
        e.stopPropagation();
        this.setState({ showEditor: true, editingButton: btn, labelInput: btn.label, commandInput: btn.command });
    };

    private closeEditor = () => {
        this.setState({ showEditor: false, editingButton: null });
    };

    private saveButton = () => {
        const { labelInput, commandInput, editingButton, buttons } = this.state;
        const label = labelInput.trim();
        const command = commandInput;
        if (!label || !command) return;

        let newButtons: ButtonConfig[];
        if (editingButton) {
            newButtons = buttons.map(b => (b.id === editingButton.id ? { ...b, label, command } : b));
        } else {
            newButtons = [...buttons, { id: genId(), label, command }];
        }
        saveButtons(newButtons);
        this.setState({ buttons: newButtons, showEditor: false, editingButton: null });
    };

    private deleteButton = (id: string, e: Event) => {
        e.stopPropagation();
        const newButtons = this.state.buttons.filter(b => b.id !== id);
        saveButtons(newButtons);
        this.setState({ buttons: newButtons });
    };

    // ── Button click ───────────────────────────────────────────
    private handleClick = (btn: ButtonConfig) => {
        if (this.state.editMode) return; // in edit mode clicks open edit
        this.props.onSendCommand(parseCommand(btn.command));
    };

    // ── Keyboard shortcuts in dialog ───────────────────────────
    private handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.saveButton();
        if (e.key === 'Escape') this.closeEditor();
    };

    // ── Desktop drag-and-drop reorder ──────────────────────────
    private dragSrcId: string | null = null;

    private onDragStart = (id: string, e: DragEvent) => {
        this.dragSrcId = id;
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    private onDragOver = (id: string, e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        this.setState({ dragOverId: id });
    };
    private onDrop = (targetId: string, e: DragEvent) => {
        e.preventDefault();
        this.reorder(this.dragSrcId, targetId);
        this.dragSrcId = null;
        this.setState({ dragOverId: null });
    };
    private onDragEnd = () => {
        this.dragSrcId = null;
        this.setState({ dragOverId: null });
    };

    // ── Touch drag-and-drop reorder (mobile) ───────────────────
    private onTouchStart = (id: string, e: TouchEvent) => {
        if (!this.state.editMode) return;
        this.touchStartX = e.touches[0].clientX;
        this.touchStartY = e.touches[0].clientY;
        this.setState({ touchDragId: id });
    };

    private onTouchMove = (e: TouchEvent) => {
        if (!this.state.touchDragId) return;
        e.preventDefault();
        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const wrap = el?.closest('[data-btnid]') as HTMLElement | null;
        const overId = wrap?.dataset.btnid ?? null;
        if (overId && overId !== this.state.touchDragId) {
            this.setState({ touchOverId: overId });
        }
    };

    private onTouchEnd = () => {
        const { touchDragId, touchOverId } = this.state;
        if (touchDragId && touchOverId) this.reorder(touchDragId, touchOverId);
        this.setState({ touchDragId: null, touchOverId: null, dragOverId: null });
    };

    private reorder(srcId: string | null, targetId: string | null) {
        if (!srcId || !targetId || srcId === targetId) return;
        const { buttons } = this.state;
        const srcIdx = buttons.findIndex(b => b.id === srcId);
        const tgtIdx = buttons.findIndex(b => b.id === targetId);
        if (srcIdx < 0 || tgtIdx < 0) return;
        const newButtons = [...buttons];
        const [removed] = newButtons.splice(srcIdx, 1);
        newButtons.splice(tgtIdx, 0, removed);
        saveButtons(newButtons);
        this.setState({ buttons: newButtons });
    }

    render(
        _: Props,
        {
            buttons,
            editMode,
            showEditor,
            editingButton,
            labelInput,
            commandInput,
            dragOverId,
            touchOverId,
            touchDragId,
        }: State
    ) {
        const activeDragOver = (id: string) => dragOverId === id || touchOverId === id;
        const isDragging = (id: string) => touchDragId === id;

        return (
            <div
                class="ttyd-buttonbar"
                onTouchMove={e => this.onTouchMove(e as TouchEvent)}
                onTouchEnd={this.onTouchEnd}
            >
                <div class="ttyd-buttonbar-inner">
                    {buttons.map(btn => (
                        <div
                            key={btn.id}
                            data-btnid={btn.id}
                            class={[
                                'ttyd-btn-wrap',
                                editMode ? 'edit-mode' : '',
                                activeDragOver(btn.id) ? 'drag-over' : '',
                                isDragging(btn.id) ? 'dragging' : '',
                            ]
                                .filter(Boolean)
                                .join(' ')}
                            draggable={editMode}
                            onDragStart={editMode ? e => this.onDragStart(btn.id, e as DragEvent) : undefined}
                            onDragOver={editMode ? e => this.onDragOver(btn.id, e as DragEvent) : undefined}
                            onDrop={editMode ? e => this.onDrop(btn.id, e as DragEvent) : undefined}
                            onDragEnd={editMode ? this.onDragEnd : undefined}
                            onTouchStart={editMode ? e => this.onTouchStart(btn.id, e as TouchEvent) : undefined}
                        >
                            <button
                                class="ttyd-btn"
                                onClick={editMode ? e => this.openEdit(btn, e) : () => this.handleClick(btn)}
                                title={editMode ? 'Click to edit' : btn.command}
                            >
                                {btn.label}
                            </button>
                            {editMode && (
                                <button class="ttyd-btn-del" onClick={e => this.deleteButton(btn.id, e)} title="Delete">
                                    ✕
                                </button>
                            )}
                        </div>
                    ))}

                    {/* ＋ Add button */}
                    <button class="ttyd-btn-add" onClick={this.openAdd} title="Add button">
                        ＋
                    </button>

                    {/* Edit mode toggle */}
                    <button
                        class={`ttyd-btn-editmode${editMode ? ' active' : ''}`}
                        onClick={this.toggleEditMode}
                        title={editMode ? 'Exit edit mode' : 'Edit buttons'}
                    >
                        ✎
                    </button>
                </div>

                {/* ── Editor dialog ── */}
                {showEditor && (
                    <div class="ttyd-editor-overlay" onClick={this.closeEditor}>
                        <div class="ttyd-editor" onClick={e => e.stopPropagation()} onKeyDown={this.handleKeyDown}>
                            <div class="ttyd-editor-title">{editingButton ? 'Edit Button' : 'Add Button'}</div>

                            <label class="ttyd-editor-label">Label</label>
                            <input
                                class="ttyd-editor-input"
                                type="text"
                                placeholder="Button label"
                                value={labelInput}
                                onInput={e => this.setState({ labelInput: (e.target as HTMLInputElement).value })}
                                autofocus
                            />

                            <label class="ttyd-editor-label">
                                Command
                                <span class="ttyd-editor-hint"> (\r \n \t \\ · Ctrl+C · ^C · \cC · \e)</span>
                            </label>
                            <textarea
                                class="ttyd-editor-textarea"
                                placeholder={'ls -la\\r\\n\nCtrl+C\n^Z\n\\x1b[A  (Up arrow)'}
                                value={commandInput}
                                onInput={e => this.setState({ commandInput: (e.target as HTMLTextAreaElement).value })}
                                rows={4}
                            />

                            <div class="ttyd-editor-actions">
                                <button class="ttyd-editor-btn ttyd-editor-cancel" onClick={this.closeEditor}>
                                    Cancel
                                </button>
                                <button class="ttyd-editor-btn ttyd-editor-save" onClick={this.saveButton}>
                                    Save
                                </button>
                            </div>
                            <div class="ttyd-editor-tip">
                                Ctrl+Enter save · Esc cancel · drag to reorder (edit mode)
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }
}
