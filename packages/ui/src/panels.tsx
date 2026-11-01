import { useEditorQuery } from '@vector-studio/react';
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  panelErrorsEqual,
  resolvePanels,
  type PanelContribution,
  type PanelError,
  type ResolvedPanel,
  type UiExtension,
} from './panel-resolve.js';

// MVP M8 contract, section 6: the panel provider, the panel list and each panel's error
// boundary. Panel open and collapsed state is React state in this module: no command, document,
// history or persisted value is written for it (M8-P4).

type PanelContextValue = Readonly<{
  panels: readonly ResolvedPanel[];
  errors: readonly PanelError[];
  report: (error: PanelError) => void;
}>;

const PanelContext = createContext<PanelContextValue | null>(null);

/** The query `PanelProvider` checks the contributions against (M8-X1). */
const EXTENSIONS = { type: 'extensions' } as const;

function usePanelContext(caller: string): PanelContextValue {
  const value = useContext(PanelContext);
  if (value === null) throw new Error(`${caller}: no PanelProvider above this component`);
  return value;
}

/** Props of `PanelProvider` (MVP M8 contract, M8-P1). */
export type PanelProviderProps = Readonly<{
  /** The host's UI extensions; their owners must be registered with the editor. */
  contributions: readonly UiExtension[];
  /** Receives each panel error once, from an effect or after a panel failed; optional. */
  onPanelError?: (error: PanelError) => void;
  children?: ReactNode;
}>;

/**
 * Holds the extension panels and their errors (MVP M8 contract, M8-P1, M8-P2). Placed below an
 * `EditorProvider` and above both `EditorPanels` and whatever reads `usePanelErrors`. It checks
 * `contributions` against the editor's `extensions` query with `resolvePanels`, keeps the
 * rejected panels' errors and the `ui.panel-failed` errors of panels that threw, and calls
 * `onPanelError` once for each: for a rejection in an effect after the render that found it, for
 * a failure when the panel's boundary caught it.
 */
export function PanelProvider({ contributions, onPanelError, children }: PanelProviderProps) {
  const extensions = useEditorQuery(EXTENSIONS);
  const resolution = useMemo(
    () => resolvePanels(contributions, extensions),
    [contributions, extensions],
  );
  // The same rejections keep one list object, so an inline `contributions` array neither
  // re-reports them nor changes what `usePanelErrors` returns.
  const stable = useRef(resolution.errors);
  if (!panelErrorsEqual(stable.current, resolution.errors)) stable.current = resolution.errors;
  const rejected = stable.current;

  const callback = useRef(onPanelError);
  useEffect(() => {
    callback.current = onPanelError;
  }, [onPanelError]);

  const reported = useRef<readonly PanelError[] | null>(null);
  useEffect(() => {
    if (reported.current === rejected) return;
    reported.current = rejected;
    for (const error of rejected) callback.current?.(error);
  }, [rejected]);

  const [failures, setFailures] = useState<readonly PanelError[]>([]);
  const failed = useRef(new Set<string>());
  const report = useCallback((error: PanelError) => {
    if (failed.current.has(error.panel)) return;
    failed.current.add(error.panel);
    setFailures((previous) => [...previous, error]);
    callback.current?.(error);
  }, []);

  const errors = useMemo(
    () => (failures.length === 0 ? rejected : [...rejected, ...failures]),
    [rejected, failures],
  );
  const value = useMemo(
    () => ({ panels: resolution.panels, errors, report }),
    [resolution.panels, errors, report],
  );
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/**
 * The panel errors the nearest `PanelProvider` holds (MVP M8 contract, M8-P1): the rejected
 * contributions in contribution order, then the panels that failed, in the order they failed.
 * The list keeps its reference while it is unchanged. Throws outside a `PanelProvider`.
 */
export function usePanelErrors(): readonly PanelError[] {
  return usePanelContext('usePanelErrors').errors;
}

/** Props of `PanelBoundary` (MVP M8 contract, M8-P3). */
export type PanelBoundaryProps = Readonly<{
  /** The ID of the panel inside, named in its `ui.panel-failed` error. */
  panel: string;
  /** Receives the `ui.panel-failed` error once the boundary caught a render error. */
  onPanelError?: (error: PanelError) => void;
  children?: ReactNode;
}>;

/** State of `PanelBoundary`: whether its panel threw. */
export type PanelBoundaryState = Readonly<{ failed: boolean }>;

/**
 * The error boundary around one extension panel (MVP M8 contract, M8-P3). When the panel throws
 * while rendering, `getDerivedStateFromError` sets the failed state, whose render is the
 * panel's `ui.panel-failed` notice, and `componentDidCatch` reports `{ code: 'ui.panel-failed',
 * panel }`; the editor and the other panels keep working. Server rendering does not run error
 * boundaries.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  /** Starts unfailed. */
  override state: PanelBoundaryState = { failed: false };

  /** The state after the panel threw: failed, for good. */
  static getDerivedStateFromError(): PanelBoundaryState {
    return { failed: true };
  }

  /** Reports the failure to `onPanelError`. */
  override componentDidCatch(): void {
    this.props.onPanelError?.({ code: 'ui.panel-failed', panel: this.props.panel });
  }

  /** The panel, or the `ui.panel-failed` notice once it failed. */
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p role="alert" data-panel-error="ui.panel-failed">
          ui.panel-failed
        </p>
      );
    }
    return this.props.children;
  }
}

function PanelSection({
  panel,
  report,
}: Readonly<{ panel: PanelContribution; report: (error: PanelError) => void }>) {
  // M8-P4: open or collapsed is React state only; a collapsed body stays mounted (hidden), so
  // its own React state survives.
  const [open, setOpen] = useState(true);
  const Body = panel.component;
  return (
    <section aria-label={panel.title} data-panel={panel.id}>
      <h2 style={{ fontSize: 'inherit', margin: 0 }}>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {panel.title}
        </button>
      </h2>
      <div hidden={!open}>
        <PanelBoundary panel={panel.id} onPanelError={report}>
          <Body />
        </PanelBoundary>
      </div>
    </section>
  );
}

/**
 * Renders the accepted extension panels of the nearest `PanelProvider`, in contribution order
 * (MVP M8 contract, M8-P1 to P4): each a `section` named by its title, with a heading button
 * that opens and collapses it (React state only) and its component inside its own
 * `PanelBoundary`. Throws outside a `PanelProvider`.
 */
export function EditorPanels() {
  const { panels, report } = usePanelContext('EditorPanels');
  return (
    <>
      {panels.map(({ panel }) => (
        <PanelSection key={panel.id} panel={panel} report={report} />
      ))}
    </>
  );
}
