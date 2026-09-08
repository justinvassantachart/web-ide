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
  TestCatalogDecoderV2,
  TestCatalogV2,
  TestDecoderFrameV2,
  TestDescriptorV2,
  TestProviderV2,
  TestReportDecoderV2,
  TestReportEventPayloadV2,
  TestReportEventV2,
  TestRunRequestV2,
  TestSelectionV2,
} from './web-ide/contracts/testing'
