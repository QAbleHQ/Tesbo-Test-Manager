import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { FieldConfig, FieldOption, FieldType } from "./custom-fields.types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkDateRange(field: string, date: string, config: FieldConfig): void {
  const today = todayIso();
  if (config.allowPastDates === false && date < today) {
    throw new BadRequestException({ field, message: "Past dates are not allowed for this field" });
  }
  if (config.allowFutureDates === false && date > today) {
    throw new BadRequestException({ field, message: "Future dates are not allowed for this field" });
  }
}

/**
 * Validates and normalizes a definition's `config` JSON at create/update time. Applies
 * server-generated option ids and returns the config that should actually be persisted.
 */
export function validateConfigShape(fieldType: FieldType, rawConfig: unknown): FieldConfig {
  const config: FieldConfig = rawConfig && typeof rawConfig === "object" ? { ...(rawConfig as FieldConfig) } : {};

  switch (fieldType) {
    case "text":
    case "long_text": {
      const ceiling = fieldType === "text" ? 10_000 : 50_000;
      if (config.maxLength != null) {
        if (!Number.isInteger(config.maxLength) || config.maxLength <= 0 || config.maxLength > ceiling) {
          throw new BadRequestException({ field: "maxLength", message: `maxLength must be a positive integer up to ${ceiling}` });
        }
      }
      if (config.defaultValue != null) {
        if (typeof config.defaultValue !== "string") {
          throw new BadRequestException({ field: "defaultValue", message: "Default value must be text" });
        }
        if (config.maxLength != null && config.defaultValue.length > config.maxLength) {
          throw new BadRequestException({ field: "defaultValue", message: `Default value exceeds maxLength (${config.maxLength})` });
        }
      }
      break;
    }
    case "boolean": {
      if (config.displayFormat && config.displayFormat !== "yes_no" && config.displayFormat !== "true_false") {
        throw new BadRequestException({ field: "displayFormat", message: "displayFormat must be 'yes_no' or 'true_false'" });
      }
      config.displayFormat = config.displayFormat || "yes_no";
      if (config.defaultValue != null && typeof config.defaultValue !== "boolean") {
        throw new BadRequestException({ field: "defaultValue", message: "Default value must be true or false" });
      }
      break;
    }
    case "single_select":
    case "multi_select": {
      const rawOptions = Array.isArray(config.options) ? config.options : [];
      if (rawOptions.length === 0) {
        throw new BadRequestException({ field: "options", message: "At least one option is required" });
      }
      const seenLabels = new Set<string>();
      const options: FieldOption[] = rawOptions.map((opt, index) => {
        const label = String((opt as FieldOption)?.label ?? "").trim();
        if (!label) throw new BadRequestException({ field: "options", message: "Every option needs a label" });
        const key = label.toLowerCase();
        if (seenLabels.has(key)) throw new BadRequestException({ field: "options", message: `Duplicate option label: ${label}` });
        seenLabels.add(key);
        return {
          id: (opt as FieldOption)?.id || randomUUID(),
          label,
          active: (opt as FieldOption)?.active !== false,
          order: Number.isInteger((opt as FieldOption)?.order) ? (opt as FieldOption).order : index
        };
      });
      config.options = options;
      const activeIds = new Set(options.filter((o) => o.active).map((o) => o.id));

      if (fieldType === "single_select") {
        if (config.defaultOptionId != null && !activeIds.has(String(config.defaultOptionId))) {
          throw new BadRequestException({ field: "defaultOptionId", message: "Default option must reference an active option" });
        }
      } else {
        if (config.minSelected != null && (!Number.isInteger(config.minSelected) || config.minSelected < 0)) {
          throw new BadRequestException({ field: "minSelected", message: "minSelected must be a non-negative integer" });
        }
        if (config.maxSelected != null) {
          if (!Number.isInteger(config.maxSelected) || config.maxSelected < 1 || config.maxSelected > options.length) {
            throw new BadRequestException({ field: "maxSelected", message: "maxSelected must be between 1 and the number of options" });
          }
          if (config.minSelected != null && config.minSelected > config.maxSelected) {
            throw new BadRequestException({ field: "minSelected", message: "Minimum selections cannot be greater than maximum selections." });
          }
        }
        if (config.defaultOptionIds != null) {
          if (!Array.isArray(config.defaultOptionIds) || config.defaultOptionIds.some((id) => !activeIds.has(String(id)))) {
            throw new BadRequestException({ field: "defaultOptionIds", message: "Default selections must reference active options" });
          }
        }
      }
      break;
    }
    case "number": {
      if (config.min != null && typeof config.min !== "number") throw new BadRequestException({ field: "min", message: "min must be a number" });
      if (config.max != null && typeof config.max !== "number") throw new BadRequestException({ field: "max", message: "max must be a number" });
      if (config.min != null && config.max != null && config.min > config.max) {
        throw new BadRequestException({ field: "min", message: "min cannot exceed max" });
      }
      config.decimalsAllowed = config.decimalsAllowed !== false;
      if (config.unit != null && String(config.unit).length > 32) {
        throw new BadRequestException({ field: "unit", message: "unit must be 32 characters or fewer" });
      }
      if (config.defaultValue != null) {
        if (typeof config.defaultValue !== "number" || !Number.isFinite(config.defaultValue)) {
          throw new BadRequestException({ field: "defaultValue", message: "Default value must be a number" });
        }
        if (config.min != null && config.defaultValue < config.min) throw new BadRequestException({ field: "defaultValue", message: `Default value must be >= ${config.min}` });
        if (config.max != null && config.defaultValue > config.max) throw new BadRequestException({ field: "defaultValue", message: `Default value must be <= ${config.max}` });
        if (config.decimalsAllowed === false && !Number.isInteger(config.defaultValue)) {
          throw new BadRequestException({ field: "defaultValue", message: "Default value must be a whole number" });
        }
      }
      break;
    }
    case "date": {
      config.allowPastDates = config.allowPastDates !== false;
      config.allowFutureDates = config.allowFutureDates !== false;
      if (config.defaultValue != null) {
        if (typeof config.defaultValue !== "string" || !DATE_RE.test(config.defaultValue)) {
          throw new BadRequestException({ field: "defaultValue", message: "Default date must be in YYYY-MM-DD format" });
        }
        checkDateRange("defaultValue", config.defaultValue, config);
      }
      break;
    }
  }

  return config;
}

/**
 * Validates and normalizes an incoming raw value against a field's type + config.
 * Returns the JSON-storable normalized value. Throws BadRequestException on failure.
 */
export function validateAndNormalizeValue(fieldName: string, fieldType: FieldType, config: FieldConfig, raw: unknown): unknown {
  switch (fieldType) {
    case "text":
    case "long_text": {
      if (typeof raw !== "string") throw new BadRequestException({ field: fieldName, message: "Value must be text" });
      const trimmed = raw.trim();
      if (config.maxLength != null && trimmed.length > config.maxLength) {
        throw new BadRequestException({ field: fieldName, message: `Value exceeds the ${config.maxLength} character limit` });
      }
      return trimmed;
    }
    case "boolean": {
      if (typeof raw !== "boolean") throw new BadRequestException({ field: fieldName, message: "Value must be true or false" });
      return raw;
    }
    case "single_select": {
      const options = config.options || [];
      const option = options.find((o) => o.id === raw && o.active);
      if (!option) throw new BadRequestException({ field: fieldName, message: "Value must be a currently active option" });
      return option.id;
    }
    case "multi_select": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
        throw new BadRequestException({ field: fieldName, message: "Value must be a list of option ids" });
      }
      const options = config.options || [];
      const activeIds = new Set(options.filter((o) => o.active).map((o) => o.id));
      const deduped = Array.from(new Set(raw as string[]));
      for (const id of deduped) {
        if (!activeIds.has(id)) throw new BadRequestException({ field: fieldName, message: "Value contains an inactive or unknown option" });
      }
      if (config.minSelected != null && deduped.length < config.minSelected) {
        throw new BadRequestException({ field: fieldName, message: `Select at least ${config.minSelected} option(s)` });
      }
      if (config.maxSelected != null && deduped.length > config.maxSelected) {
        throw new BadRequestException({ field: fieldName, message: `Select at most ${config.maxSelected} option(s)` });
      }
      return deduped;
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new BadRequestException({ field: fieldName, message: "Value must be a number" });
      if (config.min != null && raw < config.min) throw new BadRequestException({ field: fieldName, message: `Value must be >= ${config.min}` });
      if (config.max != null && raw > config.max) throw new BadRequestException({ field: fieldName, message: `Value must be <= ${config.max}` });
      if (config.decimalsAllowed === false && !Number.isInteger(raw)) {
        throw new BadRequestException({ field: fieldName, message: "Value must be a whole number" });
      }
      return raw;
    }
    case "date": {
      if (typeof raw !== "string" || !DATE_RE.test(raw)) throw new BadRequestException({ field: fieldName, message: "Value must be in YYYY-MM-DD format" });
      checkDateRange(fieldName, raw, config);
      return raw;
    }
    default:
      throw new BadRequestException({ field: fieldName, message: "Unsupported field type" });
  }
}

export function applyDefaultIfMissing(config: FieldConfig, fieldType: FieldType): unknown | undefined {
  if (config.defaultValue !== undefined) return config.defaultValue;
  if (fieldType === "single_select" && config.defaultOptionId) return config.defaultOptionId;
  if (fieldType === "multi_select" && config.defaultOptionIds?.length) return config.defaultOptionIds;
  return undefined;
}
