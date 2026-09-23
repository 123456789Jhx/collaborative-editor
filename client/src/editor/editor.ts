import { applyOps, type Block, type Op } from "@collab/shared";
import { diffToOps } from "./text-diff.js";

export interface EditorCallbacks {
  onOps(ops: Op[]): void;
}

interface FocusHint {
  blockId: string;
  offset: number;
}

const PASTE_NEWLINE = /\r\n?|\n/g;

export class Editor {
  private readonly root: HTMLElement;
  private readonly callbacks: EditorCallbacks;
  private blocks: Block[];
  private readonly elements = new Map<string, HTMLElement>();
  private readonly composing = new Set<string>();
  private focusHint: FocusHint | null = null;
  private readOnly = false;

  constructor(root: HTMLElement, initial: readonly Block[], callbacks: EditorCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.blocks = initial.map((block) => ({ id: block.id, text: block.text }));

    root.addEventListener("input", (event) => this.handleInput(event));
    root.addEventListener("keydown", (event) => this.handleKeyDown(event));
    root.addEventListener("paste", (event) => this.handlePaste(event));
    root.addEventListener("compositionstart", (event) => this.handleCompositionStart(event));
    root.addEventListener("compositionend", (event) => this.handleCompositionEnd(event));

    this.render();
  }

  getBlocks(): Block[] {
    return this.blocks.map((block) => ({ id: block.id, text: block.text }));
  }

  setBlocks(blocks: readonly Block[]): void {
    this.blocks = blocks.map((block) => ({ id: block.id, text: block.text }));
    this.render();
  }

  /**
   * A convenience, not a security boundary: the server rejects a read-only
   * user's transactions either way. This only spares them from typing into a
   * document that would silently revert under them.
   */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    for (const element of this.elements.values()) {
      element.setAttribute("contenteditable", readOnly ? "false" : "true");
    }
  }

  applyRemoteOps(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    this.blocks = applyOps(this.blocks, ops);
    this.render();
  }

  private handleInput(event: Event): void {
    if ((event as InputEvent).isComposing) return;
    const element = this.blockElement(event.target);
    if (element) this.syncFromDom(element);
  }

  private handleCompositionStart(event: Event): void {
    const element = this.blockElement(event.target);
    const blockId = element?.dataset["blockId"];
    if (blockId !== undefined) this.composing.add(blockId);
  }

  private handleCompositionEnd(event: Event): void {
    const element = this.blockElement(event.target);
    const blockId = element?.dataset["blockId"];
    if (element === null || blockId === undefined) return;
    // An IME may or may not fire a trailing `input` event, so sync here too.
    // Syncing is idempotent: identical text produces no ops.
    this.composing.delete(blockId);
    this.syncFromDom(element);
  }

  private handlePaste(event: ClipboardEvent): void {
    const element = this.blockElement(event.target);
    if (element === null) return;
    event.preventDefault();
    const text = (event.clipboardData?.getData("text/plain") ?? "").replace(PASTE_NEWLINE, " ");
    if (text.length === 0) return;
    // execCommand is deprecated but keeps pasted content flat inside a single
    // text node, which is what the caret-offset maths relies on.
    document.execCommand("insertText", false, text);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    // 229 is the legacy "IME is composing" keyCode; Enter during composition
    // belongs to the IME candidate window, not to us.
    if (event.isComposing || event.keyCode === 229) return;

    const element = this.blockElement(event.target);
    const blockId = element?.dataset["blockId"];
    if (element === null || blockId === undefined) return;

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.splitBlock(element, blockId);
      return;
    }

    if (event.key === "Backspace" && this.isCaretCollapsed(element) && this.caretOffset(element) === 0) {
      if (this.mergeWithPrevious(blockId)) event.preventDefault();
    }
  }

  private splitBlock(element: HTMLElement, blockId: string): void {
    const index = this.blocks.findIndex((block) => block.id === blockId);
    const block = this.blocks[index];
    if (index < 0 || block === undefined) return;

    let start = this.caretOffset(element);
    let end = start;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (
      range !== null &&
      !range.collapsed &&
      element.contains(range.startContainer) &&
      element.contains(range.endContainer)
    ) {
      start = this.offsetAt(element, range.startContainer, range.startOffset);
      end = this.offsetAt(element, range.endContainer, range.endOffset);
    }

    const newBlockId = `block-${crypto.randomUUID()}`;
    const ops: Op[] = [];
    if (end > start) {
      ops.push({ kind: "delete", blockId, offset: start, length: end - start });
    }
    ops.push({ kind: "split", blockId, offset: start, newBlockId });

    this.blocks.splice(
      index,
      1,
      { id: blockId, text: block.text.slice(0, start) },
      { id: newBlockId, text: block.text.slice(end) },
    );
    this.focusHint = { blockId: newBlockId, offset: 0 };
    this.render();
    this.callbacks.onOps(ops);
  }

  private mergeWithPrevious(blockId: string): boolean {
    const index = this.blocks.findIndex((block) => block.id === blockId);
    const block = this.blocks[index];
    const previous = index > 0 ? this.blocks[index - 1] : undefined;
    if (index <= 0 || block === undefined || previous === undefined) return false;

    const caret = previous.text.length;
    this.blocks.splice(index - 1, 2, { id: previous.id, text: previous.text + block.text });
    this.focusHint = { blockId: previous.id, offset: caret };
    this.render();
    this.callbacks.onOps([{ kind: "merge", blockId }]);
    return true;
  }

  private syncFromDom(element: HTMLElement): void {
    const blockId = element.dataset["blockId"];
    if (blockId === undefined) return;

    const index = this.blocks.findIndex((block) => block.id === blockId);
    const block = this.blocks[index];
    if (index < 0 || block === undefined) return;

    const next = element.textContent ?? "";
    const ops = diffToOps(blockId, block.text, next);
    if (ops.length === 0) return;

    this.blocks[index] = { id: block.id, text: next };
    this.callbacks.onOps(ops);
  }

  private render(): void {
    if (this.orderChanged()) {
      this.rebuild();
      return;
    }

    for (const block of this.blocks) {
      const element = this.elements.get(block.id);
      if (element === undefined || this.composing.has(block.id)) continue;
      if (element.textContent === block.text) continue;

      const active = document.activeElement === element;
      const caret = active ? this.caretOffset(element) : 0;
      element.textContent = block.text;
      if (active) this.setCaret(element, Math.min(caret, block.text.length));
    }

    this.applyFocusHint();
  }

  private rebuild(): void {
    this.captureFocus();
    this.elements.clear();
    this.root.replaceChildren();

    for (const block of this.blocks) {
      const element = document.createElement("p");
      element.className = "block";
      element.dataset["blockId"] = block.id;
      element.setAttribute("contenteditable", this.readOnly ? "false" : "true");
      element.spellcheck = false;
      element.textContent = block.text;
      this.elements.set(block.id, element);
      this.root.append(element);
    }

    this.applyFocusHint();
  }

  private orderChanged(): boolean {
    const children = Array.from(this.root.children);
    if (children.length !== this.blocks.length) return true;
    return children.some((child, index) => {
      const block = this.blocks[index];
      return block === undefined || (child as HTMLElement).dataset["blockId"] !== block.id;
    });
  }

  private captureFocus(): void {
    // A local split/merge has already decided where the caret belongs, so reading
    // the DOM here would overwrite that hint with the pre-edit block.
    if (this.focusHint !== null) return;
    const element = this.blockElement(document.activeElement);
    if (element === null) return;
    const blockId = element.dataset["blockId"];
    if (blockId === undefined) return;
    this.focusHint = { blockId, offset: this.caretOffset(element) };
  }

  private applyFocusHint(): void {
    const hint = this.focusHint;
    if (hint === null) return;
    // Clear before the lookup: the hint is one-shot, and a remote merge can remove
    // the block it points at. Leaving it set would block the next captureFocus().
    this.focusHint = null;
    const element = this.elements.get(hint.blockId);
    if (element === undefined) return;
    element.focus();
    this.setCaret(element, Math.min(hint.offset, (element.textContent ?? "").length));
  }

  private blockElement(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    const element = target.closest<HTMLElement>("[data-block-id]");
    return element !== null && this.root.contains(element) ? element : null;
  }

  private isCaretCollapsed(element: HTMLElement): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return true;
    const range = selection.getRangeAt(0);
    return range.collapsed && element.contains(range.startContainer);
  }

  private caretOffset(element: HTMLElement): number {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return 0;
    return this.offsetAt(element, range.startContainer, range.startOffset);
  }

  private offsetAt(element: HTMLElement, container: Node, offset: number): number {
    const pre = document.createRange();
    pre.selectNodeContents(element);
    pre.setEnd(container, offset);
    return pre.toString().length;
  }

  private setCaret(element: HTMLElement, offset: number): void {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    let remaining = offset;
    let node: Node | null = element.firstChild;
    let placed = false;

    while (node !== null) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        placed = true;
        break;
      }
      remaining -= length;
      node = node.nextSibling;
    }

    if (!placed) {
      if (element.firstChild !== null) {
        range.setStart(element.firstChild, element.firstChild.textContent?.length ?? 0);
      } else {
        range.setStart(element, 0);
      }
    }

    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
