# @luccode/plugin-components

React component primitives for Luc plugin WebViews/iframes.

```tsx
import {
  Button,
  CardShell,
  LucThemeProvider,
  SettingRow,
  Switch,
} from '@luccode/plugin-components';
import '@luccode/plugin-components/styles.css';

export function PluginPanel() {
  return (
    <LucThemeProvider mode="inherit">
      <CardShell title="Sync">
        <SettingRow
          label="Enabled"
          hint="Follows the current Luc theme."
          control={<Switch checked label="On" />}
        />
        <Button variant="primary">Run</Button>
      </CardShell>
    </LucThemeProvider>
  );
}
```

`LucThemeProvider` has three modes:

- `inherit`: use host CSS variables when the WebView/iframe receives them, then fall back to Luc defaults from `styles.css`.
- `luc`: set one of Luc's named theme token groups, such as `warm-paper` or `midnight`.
- `custom`: set only the tokens you provide. Missing tokens still fall back through host variables and SDK defaults.

Components intentionally expose stable `luc-plugin-*` classes so plugin authors can add small local refinements without depending on Luc renderer internals.
