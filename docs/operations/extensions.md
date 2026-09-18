# User-space Extensions

Packaged Alfred installations keep user-created tools under
`ALFRED_HOME/extensions/`. Package upgrades do not alter this directory.

Create a disabled scaffold:

```bash
alfred tools create example_tool --description "Describe what this does"
alfred tools test example_tool
```

Review `manifest.json`, `index.js`, the declared capabilities, and the reported
SHA-256 digest. Activation requires an explicit acknowledgement:

```bash
alfred tools enable example_tool --yes
alfred service restart
```

Alfred can also write an extension with the `extension_write` built-in tool.
That operation only writes source: it cannot activate or execute the code.
Writing or changing extension code always removes its activation. Previously
approved code whose digest changes is marked `stale` and is not loaded.

## Trust boundary

This initial extension format is trusted local JavaScript. Enabling it grants
the code the same operating-system permissions as the Alfred process. Every
activation is bound to the exact reviewed digest; after activation, calls do
not prompt again unless the tool itself implements an approval step. Declared
capabilities are review metadata; they are not an operating-system sandbox.

Only enable code you have reviewed. `alfred tools test` performs syntax and
contract checks without importing or executing the extension. Alfred imports
an extension only after its exact digest has been enabled. Disable it and
restart Alfred to unload it:

```bash
alfred tools disable example_tool
```

Changing Alfred's built-in tools or core runtime still requires a source
checkout. User-space extensions are the upgrade-safe expansion path for npm
installations.
