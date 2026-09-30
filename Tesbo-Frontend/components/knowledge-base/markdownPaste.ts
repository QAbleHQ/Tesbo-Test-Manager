// Decides whether a paste into the knowledge-base editor should be parsed as Markdown.
//
// ProseMirror's default for a plain-text clipboard is one literal paragraph per line, so Markdown
// copied from an editor, a README or a chat window landed as "# Title" / "* item" text. Parsing is
// deliberately opt-in on two conditions, so every other paste keeps its existing behaviour:
//
//   1. The clipboard carries no *rich* HTML. A copy from a web page, Google Docs or Word already has
//      real <h2>/<strong>/<ul> structure and must go through TipTap's HTML paste untouched. Code
//      editors (VS Code, etc.) also put HTML on the clipboard, but only as styled <div>/<span>
//      wrappers around the raw Markdown — that is not structure, so it doesn't count.
//   2. The plain text actually contains Markdown syntax. Ordinary prose stays one paragraph per line
//      instead of having its line breaks folded by Markdown's paragraph rules.

const RICH_HTML_TAG = /<(h[1-6]|strong|b|em|i|u|s|del|ul|ol|li|table|a|img|pre|code|blockquote|hr)[\s>/]/i;

const BLOCK_SYNTAX = /^ {0,3}(#{1,6}[ \t]+\S|[-*+][ \t]+\S|\d{1,9}[.)][ \t]+\S|>|```|~~~|([-*_])[ \t]*(\2[ \t]*){2,}$|\|.*\|[ \t]*$)/m;

const INLINE_SYNTAX = /\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/;

export function looksLikeMarkdown(text: string): boolean {
  return BLOCK_SYNTAX.test(text) || INLINE_SYNTAX.test(text);
}

export function isMarkdownPaste(text: string, html: string): boolean {
  if (!text.trim()) return false;
  if (html && RICH_HTML_TAG.test(html)) return false;
  return looksLikeMarkdown(text);
}
