// Unit tests must be immune to the developer's machine state: a lingering
// `openswap test on` marker (or env) would silently flip every mode-aware
// code path. Pin live mode here; test-mode suites opt back in explicitly.
process.env.OPENSWAP_TEST_MODE = "0";
