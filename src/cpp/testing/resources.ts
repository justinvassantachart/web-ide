import novaTestHeaderSource from './nova_test.h?raw'
import novaTestImplSource from './nova_test.cpp?raw'
import novaTestRunnerSource from './nova_test_runner.cpp?raw'

// Explicit public primitives keep Vite's private `?raw` modules out of the
// installed declaration graph.
export const NOVA_TEST_HEADER: string = novaTestHeaderSource
export const NOVA_TEST_IMPL: string = novaTestImplSource
export const NOVA_TEST_RUNNER: string = novaTestRunnerSource

export const NOVA_TEST_HEADER_PATH = '/workspace/nova_test.h'
export const NOVA_TEST_IMPL_PATH = '/workspace/nova_test.cpp'
export const NOVA_TEST_RUNNER_PATH = '/workspace/nova_test_runner.cpp'
export const NOVA_TEST_MARKER = '###NOVA_TEST###|~|'
export const NOVA_TEST_DELIMITER = '|~|'
