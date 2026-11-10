import { describe, expect, it } from 'vitest'
import { scopeWorkbenchCSS } from '../../scripts/build/scope-workbench-css.mjs'

describe('published workbench stylesheet boundary', () => {
  it('contains heading/control resets and utility classes within the workbench', () => {
    const result = scopeWorkbenchCSS(':root,:host{--color:red}.flex{display:flex}h2,button{margin:0}.web-ide-root{font:13px sans-serif}[data-theme="light"] .nova{color:black}')
    expect(result).not.toMatch(/:root|:host/)
    expect(result).toContain(':where(.web-ide-root):is(.flex)')
    expect(result).toContain(':where(.web-ide-root) h2')
    expect(result).toContain('.web-ide-root[data-theme="light"] .nova')
  })
  it('retains keyframe selectors and scoped nested media rules', () => {
    const result = scopeWorkbenchCSS('@keyframes spin{0%{opacity:0}to{opacity:1}}@media(min-width:500px){.panel{display:flex}}')
    expect(result).toContain('@keyframes spin{0%{opacity:0}to{opacity:1}}')
    expect(result).toContain(':where(.web-ide-root) .panel')
  })
})
