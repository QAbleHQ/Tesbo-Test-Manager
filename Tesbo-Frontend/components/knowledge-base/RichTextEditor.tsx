"use client";

import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import ImageExtension from "@tiptap/extension-image";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { useEffect, useRef } from "react";
import {
  IconBold,
  IconItalic,
  IconUnderline,
  IconList,
  IconListNumbers,
  IconListCheck,
  IconTable,
  IconLink,
  IconPhoto,
  IconCode,
  IconTerminal2,
  IconQuote,
  IconSeparator,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconH1,
  IconH2,
  IconH3,
  IconPilcrow,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconColumnRemove,
  IconRowInsertTop,
  IconRowInsertBottom,
  IconRowRemove,
  IconTableOff,
} from "@tabler/icons-react";

export type RichTextEditorHandle = {
  getJson: () => JSONContent;
  getHtml: () => string;
  getText: () => string;
};

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors disabled:opacity-40 ${
        active
          ? "bg-[var(--denim)] text-white"
          : "text-[var(--ink-400)] hover:bg-[var(--ink-100)] hover:text-[var(--ink-800)]"
      }`}
    >
      {children}
    </button>
  );
}

export default function RichTextEditor({
  contentJson,
  contentHtml,
  editable = true,
  onUpdate,
  resetKey,
}: {
  contentJson?: JSONContent | null;
  contentHtml?: string | null;
  editable?: boolean;
  onUpdate?: (payload: { json: JSONContent; html: string; text: string }) => void;
  // TipTap only reads `contentJson`/`contentHtml` once, when the editor is constructed below — a
  // later prop change (e.g. the caller restoring an older version) does nothing on its own. Bump
  // this to force the mounted editor to actually replace its document with the new content.
  resetKey?: string | number;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      ImageExtension,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: contentJson || contentHtml || "<p></p>",
    onUpdate: ({ editor: instance }) => {
      onUpdate?.({ json: instance.getJSON(), html: instance.getHTML(), text: instance.getText() });
    },
    editorProps: {
      attributes: {
        class: "tiptap-editor focus:outline-none min-h-[300px] text-[14px] leading-6 text-[var(--foreground)]",
      },
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  // Only fires on a real `resetKey` change (the caller bumping it after e.g. a version restore),
  // never on mount and never on an ordinary re-render — replacing content on every render would
  // reset the caret/scroll position out from under a user who is mid-edit.
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (!editor || resetKey === undefined || resetKey === lastResetKey.current) return;
    lastResetKey.current = resetKey;
    editor.commands.setContent(contentJson || contentHtml || "<p></p>");
    // contentJson/contentHtml intentionally excluded: this effect keys off `resetKey` alone, so it
    // still fires the FIRST time resetKey changes even if content happens to look referentially
    // stable to React at that instant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, editor]);

  if (!editor) return null;

  const addLink = () => {
    const url = window.prompt("Link URL");
    if (!url) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const addImage = () => {
    const url = window.prompt("Image URL");
    if (!url) return;
    editor.chain().focus().setImage({ src: url }).run();
  };

  const addTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
      {editable && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] p-1.5">
          <ToolbarButton title="Paragraph" onClick={() => editor.chain().focus().setParagraph().run()} active={editor.isActive("paragraph")}>
            <IconPilcrow size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Heading 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })}>
            <IconH1 size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Heading 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })}>
            <IconH2 size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Heading 3" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })}>
            <IconH3 size={16} stroke={1.75} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <ToolbarButton title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")}>
            <IconBold size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")}>
            <IconItalic size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")}>
            <IconUnderline size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")}>
            <IconCode size={16} stroke={1.75} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <ToolbarButton title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")}>
            <IconList size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")}>
            <IconListNumbers size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Checklist" onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")}>
            <IconListCheck size={16} stroke={1.75} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <ToolbarButton title="Table" onClick={addTable}>
            <IconTable size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Link" onClick={addLink} active={editor.isActive("link")}>
            <IconLink size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Image" onClick={addImage}>
            <IconPhoto size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive("codeBlock")}>
            <IconTerminal2 size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")}>
            <IconQuote size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <IconSeparator size={16} stroke={1.75} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <ToolbarButton title="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
            <IconArrowBackUp size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
            <IconArrowForwardUp size={16} stroke={1.75} />
          </ToolbarButton>
        </div>
      )}
      {editable && editor.isActive("table") && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] bg-[var(--surface-secondary)] p-1.5">
          <span className="px-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Table</span>
          <ToolbarButton title="Insert column before" onClick={() => editor.chain().focus().addColumnBefore().run()}>
            <IconColumnInsertLeft size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Insert column after" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            <IconColumnInsertRight size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>
            <IconColumnRemove size={16} stroke={1.75} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <ToolbarButton title="Insert row above" onClick={() => editor.chain().focus().addRowBefore().run()}>
            <IconRowInsertTop size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Insert row below" onClick={() => editor.chain().focus().addRowAfter().run()}>
            <IconRowInsertBottom size={16} stroke={1.75} />
          </ToolbarButton>
          <ToolbarButton title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
            <IconRowRemove size={16} stroke={1.75} />
          </ToolbarButton>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <ToolbarButton title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
            <IconTableOff size={16} stroke={1.75} />
          </ToolbarButton>
        </div>
      )}
      <div className="px-4 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
