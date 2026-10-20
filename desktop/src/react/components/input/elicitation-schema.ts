import type { SessionConfirmationBlock } from '../../stores/chat-types';

/**
 * Reading an elicitation request into something renderable.
 *
 * The spec describes `requestedSchema` as a flat object of primitive
 * properties, and that is what a conforming server sends. One level of nesting
 * is still rendered, as a group: a server that goes beyond the spec should cost
 * the user a slightly unusual form, not a form they cannot fill at all.
 * Anything deeper, or of a type with no faithful control, is reported as
 * unsupported rather than half-rendered.
 */

export type ElicitationFieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface ElicitationOption {
  value: string;
  label: string;
}

export interface ElicitationField {
  /** Full property path, e.g. ['address', 'city']. */
  path: string[];
  /** `path.join('.')` — the key both React and the value map use. */
  key: string;
  label: string;
  type: ElicitationFieldType;
  required: boolean;
  options?: ElicitationOption[];
  defaultValue: string | boolean;
}

export interface ElicitationGroup {
  /** Empty for the top-level group, otherwise the nested property name. */
  key: string;
  label: string;
  fields: ElicitationField[];
}

export interface ElicitationForm {
  groups: ElicitationGroup[];
  unsupported: string[];
}

export type ElicitationValues = Record<string, string | boolean>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionsFrom(property: Record<string, unknown>): ElicitationOption[] | null {
  const raw = property.enum;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const names = Array.isArray(property.enumNames) ? property.enumNames : [];
  const options: ElicitationOption[] = [];
  for (const [index, entry] of raw.entries()) {
    // A control the user picks from must show text. A non-primitive choice has
    // no honest label, so the whole field falls back to unsupported.
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') return null;
    const label = typeof names[index] === 'string' ? (names[index] as string) : String(entry);
    options.push({ value: String(entry), label });
  }
  return options;
}

function readField(
  path: string[],
  property: Record<string, unknown>,
  required: boolean,
): ElicitationField | null {
  const name = path[path.length - 1];
  const label = typeof property.title === 'string' && property.title ? property.title : name;
  const key = path.join('.');
  const options = optionsFrom(property);
  if (options) {
    const fallback = property.default;
    return {
      path,
      key,
      label,
      type: 'enum',
      required,
      options,
      defaultValue: options.some(option => option.value === String(fallback))
        ? String(fallback)
        : '',
    };
  }

  const rawType = typeof property.type === 'string' ? property.type : '';
  if (rawType === 'string') {
    return {
      path,
      key,
      label,
      type: 'string',
      required,
      defaultValue: typeof property.default === 'string' ? property.default : '',
    };
  }
  if (rawType === 'number' || rawType === 'integer') {
    return {
      path,
      key,
      label,
      type: 'number',
      required,
      defaultValue: typeof property.default === 'number' ? String(property.default) : '',
    };
  }
  if (rawType === 'boolean') {
    return {
      path,
      key,
      label,
      type: 'boolean',
      required,
      defaultValue: property.default === true,
    };
  }
  return null;
}

export function readElicitationForm(block: SessionConfirmationBlock): ElicitationForm | null {
  if (block.kind !== 'mcp_elicitation') return null;
  const schema = block.payload?.requestedSchema as Record<string, unknown> | undefined;
  const properties = schema?.properties;
  if (!isPlainObject(properties)) return { groups: [], unsupported: [] };

  const requiredAt = (parent: Record<string, unknown> | undefined): Set<string> => {
    const list = parent?.required;
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
  };

  const rootRequired = requiredAt(schema);
  const rootFields: ElicitationField[] = [];
  const groups: ElicitationGroup[] = [];
  const unsupported: string[] = [];

  for (const [name, raw] of Object.entries(properties)) {
    if (!isPlainObject(raw)) {
      unsupported.push(name);
      continue;
    }

    if (raw.type === 'object' && isPlainObject(raw.properties)) {
      const nestedRequired = requiredAt(raw);
      const fields: ElicitationField[] = [];
      let nestedOk = true;
      for (const [childName, childRaw] of Object.entries(raw.properties)) {
        if (!isPlainObject(childRaw)) { nestedOk = false; break; }
        // One level only. A grandchild object has no grouping left to render it
        // in, so the whole branch is declared unsupported instead of flattened.
        if (childRaw.type === 'object') { nestedOk = false; break; }
        const field = readField([name, childName], childRaw, nestedRequired.has(childName));
        if (!field) { nestedOk = false; break; }
        fields.push(field);
      }
      if (!nestedOk || fields.length === 0) {
        unsupported.push(name);
        continue;
      }
      groups.push({
        key: name,
        label: typeof raw.title === 'string' && raw.title ? raw.title : name,
        fields,
      });
      continue;
    }

    const field = readField([name], raw, rootRequired.has(name));
    if (field) rootFields.push(field);
    else unsupported.push(name);
  }

  return {
    groups: rootFields.length > 0 ? [{ key: '', label: '', fields: rootFields }, ...groups] : groups,
    unsupported,
  };
}

export function allElicitationFields(form: ElicitationForm | null): ElicitationField[] {
  return (form?.groups || []).flatMap(group => group.fields);
}

export function initialElicitationValues(form: ElicitationForm | null): ElicitationValues {
  const values: ElicitationValues = {};
  for (const field of allElicitationFields(form)) values[field.key] = field.defaultValue;
  return values;
}

/** Keys of required fields the user has left empty. */
export function missingRequiredFields(
  form: ElicitationForm | null,
  values: ElicitationValues,
): ElicitationField[] {
  return allElicitationFields(form).filter((field) => {
    if (!field.required) return false;
    // A boolean is answered by either state; only text-like fields can be blank.
    if (field.type === 'boolean') return false;
    const raw = values[field.key];
    return typeof raw !== 'string' || raw.trim() === '';
  });
}

export function collectElicitationValue(
  form: ElicitationForm | null,
  values: ElicitationValues,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of allElicitationFields(form)) {
    const raw = values[field.key];
    let value: unknown;
    if (field.type === 'boolean') {
      value = raw === true;
    } else {
      const text = typeof raw === 'string' ? raw : '';
      if (field.type === 'number') {
        // An untouched optional number is left out rather than sent as NaN.
        if (!text.trim()) continue;
        const numeric = Number(text);
        if (Number.isNaN(numeric)) continue;
        value = numeric;
      } else {
        if (field.type === 'enum' && !text) continue;
        value = text;
      }
    }

    if (field.path.length === 1) {
      result[field.path[0]] = value;
      continue;
    }
    const [group, name] = field.path;
    const bucket = isPlainObject(result[group]) ? result[group] as Record<string, unknown> : {};
    bucket[name] = value;
    result[group] = bucket;
  }
  return result;
}
