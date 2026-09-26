/** Optional, framework-neutral testing UI and language TestProvider bundles. */
export { testingPlugin } from './web-ide/plugins/testing'
export { cppTestProvider, cppTestingPlugin } from './cpp/testing/provider'
export {
  pythonTestingPlugin,
  pythonUnittestTestProvider,
} from './python/testing/provider'
export {
  createTestingControllerV2,
  TestingSelectionStaleError,
} from './testing/testing-controller-v2'
export type {
  CreateTestingControllerV2Options,
  IDETestingControllerV2,
  IDETestingSnapshotV2,
  TestingV2State,
} from './testing/testing-controller-v2'
export type {
  TestCatalogV2,
  TestDecoderFrameV2,
  TestDescriptorV2,
  TestProviderV2,
  TestReportDecoderV2,
  TestReportEventPayloadV2,
  TestReportEventV2,
  TestRunIntentV2,
  TestRunRequestV2,
  TestSelectionV2,
} from './web-ide/contracts/testing'

export { CPP_TEST_SUPPORT_FILES, CPP_TEST_RESERVED_PATHS, CPP_TEST_HEADER_PATH, CPP_TEST_IMPL_PATH, CPP_TEST_RUNNER_PATH, CPP_TEST_RUNNER_SOURCE, CPP_TEST_CONFIG_PATH, validateCppTestSupportFiles, prepareCppTestingSupport } from './cpp/testing/provider'
