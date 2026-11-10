import postcss from 'postcss'

/** Scope compiled utility and component styles, including utility classes on
 * the workbench root itself. Font faces/keyframes retain their CSS semantics. */
export function scopeWorkbenchCSS(css) {
  const root = postcss.parse(css)
  root.walkRules((rule) => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return
    }
    rule.selectors = rule.selectors.flatMap((selector) => {
      if (selector === ':root' || selector === ':host') return ['.web-ide-root']
      if (selector.includes('.web-ide-root')) return [selector]
      if (/^\[data-theme[=\]]/.test(selector)) {
        return [selector.replace(/^(\[data-theme[^\]]+\])\s*/, '.web-ide-root$1 ')]
      }
      return [`:where(.web-ide-root):is(${selector})`, `:where(.web-ide-root) ${selector}`]
    })
  })
  return root.toString()
}
