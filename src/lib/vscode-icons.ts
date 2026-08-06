// Curated Material Icon Theme assets. Keeping a small explicit table makes the
// package portable and avoids eagerly bundling the dependency's 1,200+ SVGs.
import cUrl from 'material-icon-theme/icons/c.svg?url'
import cppUrl from 'material-icon-theme/icons/cpp.svg?url'
import fileUrl from 'material-icon-theme/icons/file.svg?url'
import folderUrl from 'material-icon-theme/icons/folder.svg?url'
import folderOpenUrl from 'material-icon-theme/icons/folder-open.svg?url'
import headerUrl from 'material-icon-theme/icons/h.svg?url'
import javascriptUrl from 'material-icon-theme/icons/javascript.svg?url'
import jsonUrl from 'material-icon-theme/icons/json.svg?url'
import markdownUrl from 'material-icon-theme/icons/markdown.svg?url'
import pythonUrl from 'material-icon-theme/icons/python.svg?url'
import rustUrl from 'material-icon-theme/icons/rust.svg?url'
import typescriptUrl from 'material-icon-theme/icons/typescript.svg?url'

const extensionIcons: Readonly<Record<string, string>> = {
  c: cUrl,
  cc: cppUrl,
  cpp: cppUrl,
  cxx: cppUrl,
  h: headerUrl,
  hh: headerUrl,
  hpp: headerUrl,
  hxx: headerUrl,
  js: javascriptUrl,
  jsx: javascriptUrl,
  json: jsonUrl,
  md: markdownUrl,
  mdx: markdownUrl,
  py: pythonUrl,
  rs: rustUrl,
  ts: typescriptUrl,
  tsx: typescriptUrl,
}

export function getFileIconUrl(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  return extensionIcons[extension] ?? fileUrl
}

export function getFolderIconUrl(_folderName: string, expanded: boolean): string {
  return expanded ? folderOpenUrl : folderUrl
}
