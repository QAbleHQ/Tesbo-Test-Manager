// Mirrors the backend rules in Tesbo-Backend-Nest/src/common/person-name.util.ts and
// Tesbo-Backend-Nest/src/auth/password.service.ts (assertValidPassword) — keep both in sync.

export const NAME_MAX_LENGTH = 100;
// Signup's First name / Last name fields use a stricter cap than the shared single-field "Name"
// above (e.g. invite registration) — mirrors the backend's SignupService.startSelfServeSignup.
export const SIGNUP_NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 16;
export const EMAIL_MAX_LENGTH = 255;

export const PASSWORD_RULES_HINT = `${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters, with an uppercase letter, a lowercase letter, and a number.`;

// Unicode letters/marks so accented and non-Latin names aren't rejected, plus the
// punctuation real names use: space, hyphen, apostrophe, period (e.g. "Jr.").
const NAME_CHARS_RE = /^[\p{L}\p{M} '.-]+$/u;

export function validateName(value: string, fieldLabel = "Name", maxLength = NAME_MAX_LENGTH): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${fieldLabel} is required`;
  if (trimmed.length > maxLength) return `${fieldLabel} must be at most ${maxLength} characters`;
  if (!NAME_CHARS_RE.test(trimmed)) {
    return `${fieldLabel} can only contain letters, spaces, hyphens, apostrophes, and periods`;
  }
  return null;
}

export function validatePasswordValue(value: string): string | null {
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (value.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (!/[a-z]/.test(value)) return "Password must include at least one lowercase letter";
  if (!/[A-Z]/.test(value)) return "Password must include at least one uppercase letter";
  if (!/[0-9]/.test(value)) return "Password must include at least one number";
  return null;
}

export function validateEmailValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Email is required";
  if (trimmed.length > EMAIL_MAX_LENGTH) return `Email must be at most ${EMAIL_MAX_LENGTH} characters`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address";
  return null;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts (createProject / updateProject).
// PROJECT_NAME_MAX_LENGTH is a product-chosen cap, well under the projects.name VARCHAR(255)
// column — keep in sync with the backend constant, not the column limit.
export const PROJECT_NAME_MIN_LENGTH = 3;
export const PROJECT_NAME_MAX_LENGTH = 30;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;

export function validateProjectName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Project name is required";
  if (trimmed.length < PROJECT_NAME_MIN_LENGTH) return `Project name must be at least ${PROJECT_NAME_MIN_LENGTH} characters`;
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) return `Project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`;
  return "";
}

export function validateProjectDescription(value: string): string {
  if (value.trim().length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    return `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`;
  }
  return "";
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts — product-chosen cap (matches
// PROJECT_NAME_MAX_LENGTH), well under the projects.key VARCHAR(32) column. An explicitly typed
// key is validated against this, not silently truncated. (The shorter auto-derived-from-name key
// is a backend-only UX choice and has nothing to validate here — the user never typed it.)
export const PROJECT_KEY_MAX_LENGTH = 30;

export function validateProjectKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return ""; // blank is fine — the backend derives a key from the name
  const sanitized = trimmed.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!sanitized) return "Project key must contain at least one letter or number";
  if (sanitized.length > PROJECT_KEY_MAX_LENGTH) return `Project key must be at most ${PROJECT_KEY_MAX_LENGTH} characters`;
  return "";
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts's validateProjectIcon. A custom glyph
// replaces the auto-derived initial on a project's colored badge, so it's meant for one emoji or a
// couple of typed letters — grapheme-counted (not code-unit length) so a single emoji built from
// several code points (a ZWJ sequence, a skin-tone modifier) still counts as one character.
export const PROJECT_ICON_GLYPH_MAX_GRAPHEMES = 2;
const PROJECT_ICON_GLYPH_MAX_LENGTH = 16;

function graphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (s) => s.segment);
  }
  return Array.from(value);
}

function countGraphemes(value: string): number {
  return graphemes(value).length;
}

/**
 * Truncates as the user types, so the input can never exceed the limit in the first place — the
 * inline validation error below is then only reachable via a paste/programmatic fill, not normal
 * typing.
 */
export function truncateProjectIconGlyph(value: string): string {
  return graphemes(value).slice(0, PROJECT_ICON_GLYPH_MAX_GRAPHEMES).join("");
}

export function validateProjectIconGlyph(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return ""; // blank clears the override — falls back to the generated initial
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return "Icon glyph contains unsupported characters";
  if (trimmed.length > PROJECT_ICON_GLYPH_MAX_LENGTH || countGraphemes(trimmed) > PROJECT_ICON_GLYPH_MAX_GRAPHEMES) {
    return `Icon glyph must be at most ${PROJECT_ICON_GLYPH_MAX_GRAPHEMES} characters`;
  }
  return "";
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts — LegacyService.KB_ALLOWED_EXTENSIONS,
// the FilesInterceptor("files", 10, ...) file-count limit, and KB_MAX_UPLOAD_SIZE (itself driven
// by the MAX_UPLOAD_SIZE env var, currently 50MB). Keep all three in sync with the backend.
// Archives (zip) and executables (exe) are deliberately excluded — a zip can hide anything,
// including an executable, past this extension check.
export const KB_ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "svg",
  "pdf", "doc", "docx", "txt", "md",
  "xls", "xlsx", "csv",
  "ppt", "pptx",
  "js", "ts", "java", "py", "json", "xml", "yaml", "yml", "sql", "html", "css",
  "mp3", "wav", "m4a",
  "mp4", "mov", "webm"
]);
export const KB_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const KB_MAX_FILES_PER_UPLOAD = 10;
export const KB_ACCEPT_ATTR = [...KB_ALLOWED_EXTENSIONS].map((ext) => `.${ext}`).join(",");
export const KB_UPLOAD_HINT =
  `Images, PDF, Word/Excel/PowerPoint, code/text files, or audio/video (no zip or executable files) · Max ${KB_MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB per file · Up to ${KB_MAX_FILES_PER_UPLOAD} files at a time`;

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/** Validates one file to upload to the knowledge base. Returns an error message, or null if valid. */
export function validateKnowledgeBaseFile(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!ext || !KB_ALLOWED_EXTENSIONS.has(ext)) {
    return `${file.name}: this file type is not supported`;
  }
  if (file.size > KB_MAX_FILE_SIZE_BYTES) {
    return `${file.name}: file is too large (max ${KB_MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB)`;
  }
  return null;
}

// Mirrors Tesbo-Backend-Nest/migrations/V45_knowledge_base_v2.sql — knowledge_documents.title is
// VARCHAR(512), and legacy.service.ts (createKnowledgeDocument / updateKnowledgeDocument) enforces
// the same limit server-side.
export const KB_DOCUMENT_TITLE_MAX_LENGTH = 512;

/** Validates a knowledge base document title. Returns an error message, or null if valid. */
export function validateKnowledgeDocumentTitle(title: string): string | null {
  if (title.trim().length > KB_DOCUMENT_TITLE_MAX_LENGTH) {
    return `Title must be at most ${KB_DOCUMENT_TITLE_MAX_LENGTH} characters`;
  }
  return null;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts (LegacyService.KB_FOLDER_NAME_MAX_LENGTH,
// enforced in createKnowledgeFolder / updateKnowledgeFolder). A product-level cap, tighter than the
// knowledge_folders.name VARCHAR(255) column — folder names render in narrow tree/breadcrumb UI.
export const KB_FOLDER_NAME_MAX_LENGTH = 50;

/** Validates a knowledge base folder name. Returns an error message, or null if valid. */
export function validateKnowledgeFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required";
  if (trimmed.length > KB_FOLDER_NAME_MAX_LENGTH) return `Folder name must be at most ${KB_FOLDER_NAME_MAX_LENGTH} characters`;
  return null;
}

/**
 * localStorage key marking a document as created from the "Blank document" template, so the
 * editor can require both a title and content instead of the usual title-or-content rule.
 * Set at creation time (knowledge-base/page.tsx) and read in the document editor.
 */
export function blankDocumentFlagKey(documentId: string): string {
  return `kb-blank-doc:${documentId}`;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts — KB_ALLOWED_EXTENSIONS and
// EVIDENCE_MAX_FILE_SIZE / assertValidEvidenceFiles — keep both in sync. The server is still the
// authority; this copy exists so a rejected file is named the moment it is picked, instead of after
// a full upload that the modal used to swallow silently (Basecamp 10226296533).
export const EVIDENCE_ALLOWED_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "svg",
  "pdf", "doc", "docx", "txt", "md",
  "xls", "xlsx", "csv",
  "ppt", "pptx",
  "js", "ts", "java", "py", "json", "xml", "yaml", "yml", "sql", "html", "css",
  "mp3", "wav", "m4a",
  "mp4", "mov", "webm",
];

export const EVIDENCE_MAX_FILE_SIZE = 25 * 1024 * 1024;

// The picker's `accept` list. Advisory only — a viewer can always switch the dialog to "All files",
// which is why validateEvidenceFile still runs on everything that comes back.
export const EVIDENCE_ACCEPT_ATTRIBUTE = EVIDENCE_ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

export function formatFileSizeShort(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function validateEvidenceFile(file: { name: string; size: number }): string | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (!ext) return `${file.name} has no file extension, so its type can't be determined.`;
  if (!EVIDENCE_ALLOWED_EXTENSIONS.includes(ext)) return `${file.name}: .${ext} files aren't supported.`;
  if (file.size <= 0) return `${file.name} is empty (0 bytes).`;
  if (file.size > EVIDENCE_MAX_FILE_SIZE) {
    return `${file.name} is ${formatFileSizeShort(file.size)}, which is over the ${formatFileSizeShort(EVIDENCE_MAX_FILE_SIZE)} limit.`;
  }
  return null;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts — SUITE_NAME_MAX_LENGTH, enforced in
// createSuite / updateSuite. Matches the suites.name VARCHAR(255) column width exactly (unlike
// PROJECT_NAME_MAX_LENGTH, there's no tighter product-chosen cap here).
export const SUITE_NAME_MAX_LENGTH = 255;

export function validateSuiteName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Suite name is required";
  if (trimmed.length > SUITE_NAME_MAX_LENGTH) return `Suite name must be at most ${SUITE_NAME_MAX_LENGTH} characters`;
  return "";
}

// Test run environments (project settings > Test Environments) are stored inside the project's
// free-form settings JSONB, with no column width and no backend validation at all — these are a
// product-level cap picked here, matching the other short-label fields (KB_FOLDER_NAME_MAX_LENGTH).
export const ENVIRONMENT_NAME_MAX_LENGTH = 50;
export const ENVIRONMENT_URL_MAX_LENGTH = 500;

/** Validates a test run environment's name, including uniqueness against the other environments. */
export function validateEnvironmentName(value: string, existing: { name: string }[]): string {
  const trimmed = value.trim();
  if (!trimmed) return "Environment name is required";
  if (trimmed.length > ENVIRONMENT_NAME_MAX_LENGTH) {
    return `Environment name must be at most ${ENVIRONMENT_NAME_MAX_LENGTH} characters`;
  }
  if (existing.some((item) => item.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return "An environment with this name already exists";
  }
  return "";
}

/** Validates a test run environment's URL: required, bounded length, http(s) only, and unique. */
export function validateEnvironmentUrl(value: string, existing: { url: string }[]): string {
  const trimmed = value.trim();
  if (!trimmed) return "Environment URL is required";
  if (trimmed.length > ENVIRONMENT_URL_MAX_LENGTH) {
    return `Environment URL must be at most ${ENVIRONMENT_URL_MAX_LENGTH} characters`;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a valid URL, e.g. https://staging.example.com";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Environment URL must start with http:// or https://";
  }
  if (existing.some((item) => item.url.trim().toLowerCase() === trimmed.toLowerCase())) {
    return "This URL is already added to another environment";
  }
  return "";
}
