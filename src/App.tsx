import { ConfirmSheet, Sidebar, TitleBar, Toasts, Tray, Welcome } from "./components/Shell";
import { DiskMap } from "./components/DiskMap";
import { Overview } from "./components/Overview";
import { Projects } from "./components/Projects";
import { Caches, Docker, LargeFiles, SettingsView } from "./components/Views";
import { StoreProvider, useStore } from "./state";

function Content() {
  const { view, result, scanning, restoring } = useStore();
  if (view === "settings") return <SettingsView />;
  // Avoid flashing the empty welcome screen while the last scan loads.
  if (restoring) return null;
  if (view === "docker") return <Docker />;
  if (!result || scanning) return <Welcome />;
  switch (view) {
    case "projects":
      return <Projects />;
    case "caches":
      return <Caches />;
    case "large":
      return <LargeFiles />;
    case "map":
      return <DiskMap />;
    default:
      return <Overview />;
  }
}

function Frame() {
  const { view, result, scanning } = useStore();
  const bare = (!result || scanning) && view !== "settings" && view !== "docker";
  return (
    <div className="app">
      <div className="wallpaper" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <TitleBar />
      <Sidebar />
      <main className="main">
        <div className="scroll" style={bare ? { padding: 0 } : undefined} key={view}>
          <Content />
        </div>
        <Tray />
      </main>
      <ConfirmSheet />
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Frame />
    </StoreProvider>
  );
}
