import { Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import ImageExtension from "@tiptap/extension-image";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";

// The knowledge-base document schema, shared by the editor and by `markdownToDocument` below so a
// document built outside the editor has exactly the nodes/marks the editor can load and edit.
export const KB_EDITOR_EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  ImageExtension,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  // Only consulted when a caller passes `contentType: "markdown"` (the editor's paste handler, and
  // `markdownToDocument`) — loading, saving and restoring documents still go through JSON/HTML.
  Markdown,
];

/**
 * Converts Markdown to the JSON/HTML/text triple a knowledge document is stored as. Runs a throwaway
 * headless editor rather than a hand-written converter so the stored HTML and text are exactly what
 * the editor itself would produce for that document (getHTML/getText), for every node type.
 * Browser-only: TipTap needs a DOM.
 */
export function markdownToDocument(markdown: string): { json: JSONContent; html: string; text: string } {
  const editor = new Editor({ extensions: KB_EDITOR_EXTENSIONS, content: markdown, contentType: "markdown" });
  try {
    return { json: editor.getJSON(), html: editor.getHTML(), text: editor.getText() };
  } finally {
    editor.destroy();
  }
}
