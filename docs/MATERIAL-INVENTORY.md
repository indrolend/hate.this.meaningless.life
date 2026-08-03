# Existing material

| Material | Status | Intended use |
| --- | --- | --- |
| Command HUD v21 | complete 641-line PowerShell prototype | behavioral reference and immediate Windows utility |
| DataFactory extension 0.2.0 | packages and passes four core tests | project/order/agent-packet foundation |
| Portable bootstrap | functional prototype with known root-selection limitations | dependency and launcher foundation |
| Digital Breakdown | existing private native game repository | read-only integration fixture |

## Command HUD v21 capabilities

- dedicated PowerShell runspace;
- asynchronous execution and cancellation;
- project/session JSONL history;
- active log polling and separate live window;
- latest-output and complete-history clipboard operations;
- click-to-copy and click-to-paste/run;
- mouse-wheel command history;
- activity-derived palette and face states;
- suppressed boundary backspace/left-key bell.

## DataFactory 0.2.0 capabilities

- Git project inspection;
- deterministic order IDs;
- structured authority snapshot;
- provider-neutral agent packet;
- `.datafactory/orders` persistence;
- compact PROJECT, WORK, INSPECT, and CHAT panel;
- syntax checks and Node tests;
- packaged VSIX.

## Known gaps

- The two implementations are not integrated.
- The portable bootstrap formerly inherited accidental directories and must use explicit clone/open state.
- Capability discovery is not implemented.
- Digital Breakdown has not yet been exercised through the new UI.
- No cross-platform package exists yet.
