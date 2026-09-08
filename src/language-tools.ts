export {
  createCppClangdProvider,
  cppLanguageToolingPlugin,
  cppLanguageToolingProvider,
} from './clangd/plugin'
export type { CreateCppClangdProviderOptions } from './clangd/plugin'
export { isClangdEnabled, setClangdEnabled } from './clangd/preferences'
