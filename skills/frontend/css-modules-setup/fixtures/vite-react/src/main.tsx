import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import "#styles/global.css";
import { atoms } from "#styles";
import { ReferenceButton } from "./reference-button";
import probeStyles from "./unlayered-probe.module.css";

function Fixture() {
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [saveActions, setSaveActions] = useState(0);
  const [pressed, setPressed] = useState(false);

  function save() {
    setSaveActions((count) => count + 1);
    setLoading(true);
  }

  return (
    <main>
      <h1>CSS Modules reference fixture</h1>
      <label>
        <input
          type="checkbox"
          checked={disabled}
          onChange={(event) => setDisabled(event.currentTarget.checked)}
        />
        Disable save
      </label>
      <ReferenceButton
        className="caller-class"
        disabled={disabled}
        loading={loading}
        onClick={save}
        pressed={false}
        progress={0.6}
        variant="primary"
      >
        Save
      </ReferenceButton>
      <button
        type="button"
        data-testid="complete-save"
        disabled={!loading}
        onClick={() => setLoading(false)}
      >
        Complete save
      </button>
      <output data-testid="save-action-count">{saveActions}</output>
      <ReferenceButton
        variant="secondary"
        pressed={pressed}
        onClick={() => setPressed((value) => !value)}
      >
        Pin
      </ReferenceButton>
      <div className={`${atoms.layerProbe} ${probeStyles.layerProbe}`} data-testid="layer-probe">
        Cascade probe
      </div>
      <div className={probeStyles.composed} data-testid="composes-probe">
        Composes probe
      </div>
    </main>
  );
}

const runtime = globalThis as typeof globalThis & { __cssModulesFixtureRoot?: Root };
runtime.__cssModulesFixtureRoot ??= createRoot(document.getElementById("root")!);
runtime.__cssModulesFixtureRoot.render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
