"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { IconBold, IconItalic, IconLink, IconList, IconListNumbers } from "@tabler/icons-react";
import { ToolbarButton } from "@/components/knowledge-base/RichTextEditor";
import { isMarkdownPaste } from "@/components/knowledge-base/markdownPaste";
import { MemberAvatar } from "@/components/bugs/BugBadges";
import { commentDocToMarkdown, markdownToCommentHtml } from "@/lib/commentMarkdown";

export type MentionMember = { userId: string; name: string; email: string };

/*
 * The schema is cut down to what a comment stores (see lib/commentMarkdown.ts): bold, italic, links,
 * bullet and numbered lists, paragraphs and line breaks. Anything else pasted in — headings, tables,
 * code, underline — is kept as its text rather than as formatting the stored Markdown can't express.
 */
const COMMENT_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    underline: false,
    link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" },
  }),
];

const MAX_SUGGESTIONS = 6;

/** The member's label as a mention: their name, or their email when the name is missing or shared. */
function mentionLabel(member: MentionMember, all: MentionMember[]): string {
  const name = member.name?.trim();
  if (!name) return member.email;
  const shared = all.some((other) => other.userId !== member.userId && other.name?.trim().toLowerCase() === name.toLowerCase());
  // The server resolves "@Name" to the first member holding that name, so a shared name would
  // mention the wrong person — the email is unambiguous.
  return shared ? member.email : name;
}

type MentionQuery = { query: string; from: number; to: number };

// What a non-text node (a hard break) reads as, so it can never be taken for part of a name.
const NON_TEXT = String.fromCharCode(0xfffc);
const MENTION_AT_CARET = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_.@])@([^@\n${NON_TEXT}]{0,40})$`, "u");

/** An "@query" ending at the caret, where the "@" starts a word (so not the middle of an email). */
function mentionAtCaret(editor: Editor): MentionQuery | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, NON_TEXT);
  const match = MENTION_AT_CARET.exec(before);
  if (!match) return null;
  return { query: match[1], from: selection.from - match[1].length - 1, to: selection.from };
}

/**
 * Rich-text box for bug comments. Emits Markdown (never HTML) through `onChange`; mount it with a
 * new `key` to clear it. `@` opens a picker of project members that inserts plain "@Name" text,
 * which is what the server's mention parser reads.
 */
export default function CommentEditor({
  initialMarkdown = "",
  onChange,
  onSubmit,
  onPasteFiles,
  members,
  ariaLabel,
  placeholder,
  autoFocus = false,
}: {
  initialMarkdown?: string;
  onChange: (markdown: string) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  /** Files (e.g. a screenshot) pasted into the box, for the caller to stage as attachments. */
  onPasteFiles?: (files: File[]) => void;
  members: MentionMember[];
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [isEmpty, setIsEmpty] = useState(!initialMarkdown.trim());
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape closes the picker for this "@"; it reopens once the caret leaves it.
  const dismissedFrom = useRef<number | null>(null);

  const query = mention?.query.toLowerCase() ?? "";
  const suggestions = mention
    ? members
        .filter((m) => (m.name ?? "").toLowerCase().includes(query) || m.email.toLowerCase().includes(query))
        .slice(0, MAX_SUGGESTIONS)
    : [];

  // ProseMirror's key and paste handlers are fixed when the editor is built, so they read the
  // current picker state and callbacks through refs.
  const latest = useRef({ mention, suggestions, activeIndex, onSubmit, onPasteFiles, members });
  const editorRef = useRef<Editor | null>(null);

  function refreshMention(instance: Editor) {
    const found = mentionAtCaret(instance);
    if (!found) dismissedFrom.current = null;
    const next = found && found.from !== dismissedFrom.current ? found : null;
    if (next?.from !== latest.current.mention?.from) setActiveIndex(0);
    setMention(next);
  }

  function insertMention(member: MentionMember) {
    const instance = editorRef.current;
    const current = latest.current.mention;
    if (!instance || !current) return;
    instance
      .chain()
      .focus()
      .insertContentAt({ from: current.from, to: current.to }, { type: "text", text: `@${mentionLabel(member, latest.current.members)} ` })
      .run();
    setMention(null);
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: COMMENT_EXTENSIONS,
    content: initialMarkdown ? markdownToCommentHtml(initialMarkdown) : "",
    autofocus: autoFocus ? "end" : false,
    onCreate: ({ editor: instance }) => setIsEmpty(instance.isEmpty),
    onUpdate: ({ editor: instance }) => {
      setIsEmpty(instance.isEmpty);
      onChange(commentDocToMarkdown(instance.getJSON()));
      refreshMention(instance);
    },
    onSelectionUpdate: ({ editor: instance }) => refreshMention(instance),
    onBlur: () => setMention(null),
    editorProps: {
      attributes: {
        class: "tiptap-editor min-h-[64px] max-h-[320px] overflow-y-auto px-3 py-2 text-[13px] leading-5 text-[var(--foreground)]",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
      },
      handleKeyDown: (_view, event) => {
        const { mention: open, suggestions: list, activeIndex: index, onSubmit: submit } = latest.current;
        if (open && list.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((index + step + list.length) % list.length);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            insertMention(list[Math.min(index, list.length - 1)]);
            return true;
          }
          if (event.key === "Escape") {
            // Only the picker closes: the side panel (Drawer) closes on any Escape reaching document.
            event.stopPropagation();
            dismissedFrom.current = open.from;
            setMention(null);
            return true;
          }
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && submit) {
          submit();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const clipboard = event.clipboardData;
        const text = clipboard?.getData("text/plain") ?? "";
        const html = clipboard?.getData("text/html") ?? "";
        const files = Array.from(clipboard?.files ?? []);
        // A copied screenshot arrives as a file with no text; it becomes an attachment, since the
        // stored Markdown has no inline images.
        if (files.length && !text.trim() && latest.current.onPasteFiles) {
          latest.current.onPasteFiles(files);
          return true;
        }
        // Markdown copied as plain text is parsed through the same renderer the comment will be
        // shown with; rich HTML (a web page, Docs, Word) falls through to TipTap's own HTML paste.
        const instance = editorRef.current;
        if (instance && isMarkdownPaste(text, html)) {
          return instance.commands.insertContent(markdownToCommentHtml(text));
        }
        return false;
      },
    },
  });
  // Refreshed after every render; React runs this before it handles the next key or paste event.
  useEffect(() => {
    latest.current = { mention, suggestions, activeIndex, onSubmit, onPasteFiles, members };
    editorRef.current = editor;
  });

  if (!editor) return null;

  const setLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const input = window.prompt("Link URL (http or https)", previous ?? "https://");
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed || trimmed === "https://") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    // Only web links are stored as links (see lib/commentMarkdown.ts); anything else is refused here
    // rather than silently becoming plain text on save.
    if (!/^https?:\/\/\S+$/i.test(href)) {
      window.alert("Only http:// and https:// links are supported.");
      return;
    }
    if (editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  };

  return (
    <div className="relative rounded-[6px] border border-[var(--border)] bg-[var(--surface)] focus-within:border-[var(--brand-primary)]">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] p-1">
        <ToolbarButton title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")}>
          <IconBold size={15} stroke={1.75} />
        </ToolbarButton>
        <ToolbarButton title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")}>
          <IconItalic size={15} stroke={1.75} />
        </ToolbarButton>
        <ToolbarButton title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")}>
          <IconList size={15} stroke={1.75} />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")}>
          <IconListNumbers size={15} stroke={1.75} />
        </ToolbarButton>
        <ToolbarButton title="Link" onClick={setLink} active={editor.isActive("link")}>
          <IconLink size={15} stroke={1.75} />
        </ToolbarButton>
      </div>
      <div className="relative">
        {isEmpty && placeholder && (
          <span aria-hidden className="pointer-events-none absolute left-3 top-2 text-[13px] text-[var(--muted-soft)]">
            {placeholder}
          </span>
        )}
        <EditorContent editor={editor} />
      </div>
      {mention && suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mention a project member"
          className="absolute left-2 right-2 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-[8px] border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {suggestions.map((member, i) => (
            <li
              key={member.userId}
              role="option"
              aria-selected={i === activeIndex}
              // mousedown, not click: a click would blur the editor first, which closes the picker.
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(member);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px] ${
                i === activeIndex ? "bg-[var(--surface-secondary)]" : ""
              }`}
            >
              <MemberAvatar name={member.name || member.email} seed={member.userId} size={20} />
              <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{member.name || member.email}</span>
              {member.name && <span className="truncate text-[11px] text-[var(--muted-soft)]">{member.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
