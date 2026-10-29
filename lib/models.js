import { ValidationError } from './cards.js';

/** Aliases `claude --model` resolves to the latest model of a family; a full model name works too. */
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
/** What `claude --effort` accepts. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Starts with a letter or digit so the value can never be read as another flag; `opus[1m]` style suffixes are allowed.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}(\[[A-Za-z0-9]{1,10}\])?$/;

/** `undefined` = not given (keep what is set), `null` = cleared (use the default), otherwise the model to pass to `--model`. */
export function parseModel(v) {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v.trim() : v === null ? '' : null;
  if (s === null) throw new ValidationError('model must be a string');
  if (!s) return null;
  if (!MODEL_RE.test(s)) throw new ValidationError(`Invalid model: ${s} (an alias such as ${MODEL_ALIASES.join(', ')}, or a full model name)`);
  return s;
}

/** Same convention as parseModel, for `--effort`. */
export function parseEffort(v) {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v.trim() : v === null ? '' : null;
  if (s === null) throw new ValidationError('effort must be a string');
  if (!s) return null;
  if (!EFFORTS.includes(s)) throw new ValidationError(`effort must be one of ${EFFORTS.join(', ')}`);
  return s;
}
