import NOVA_TEST_HEADER from './nova_test.h?raw'
import NOVA_TEST_IMPL from './nova_test.cpp?raw'
import NOVA_TEST_RUNNER from './nova_test_runner.cpp?raw'

export { NOVA_TEST_HEADER, NOVA_TEST_IMPL, NOVA_TEST_RUNNER }

export const NOVA_TEST_HEADER_PATH = '/workspace/nova_test.h'
export const NOVA_TEST_IMPL_PATH = '/workspace/nova_test.cpp'
export const NOVA_TEST_RUNNER_PATH = '/workspace/nova_test_runner.cpp'
export const NOVA_TEST_MARKER = '###NOVA_TEST###|~|'
export const NOVA_TEST_DELIMITER = '|~|'
