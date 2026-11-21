// Path helpers that work with both / and \ separators.

export function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function dirname(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0) return path;
  if (i === 0) return path[0];
  return path[i - 1] === ':' ? path.slice(0, i + 1) : path.slice(0, i);
}

export function join(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

// The filesystem can return Windows extended paths alongside ordinary drive and UNC paths.
export function portablePath(path) {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
}

function normalized(path) {
  const portable = portablePath(path);
  const forward = portable.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(forward) || portable.startsWith('\\\\') ? forward.toLowerCase() : forward;
}

export function samePath(a, b) {
  return a != null && b != null && normalized(a) === normalized(b);
}

export function isInside(path, dir) {
  return normalized(path).startsWith(normalized(dir) + '/');
}

/** Path of `path` relative to `dir`, with forward slashes. */
export function relative(path, dir) {
  if (!isInside(path, dir)) return path;
  const parent = portablePath(dir).replace(/[\\/]+$/, '');
  return portablePath(path).slice(parent.length + 1).replace(/\\/g, '/');
}

/** "notes.md" → ["notes", ".md"]. */
export function splitExtension(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}
