import { Group, Panel, Separator } from "react-resizable-panels";
import { Chat } from "./components/Chat";
import "./App.css";

function App() {
  return (
    <Group orientation="horizontal" className="panel-group">
      <Panel defaultSize={35} minSize={20} className="panel">
        <Chat />
      </Panel>
      <Separator className="resize-handle" />
      <Panel defaultSize={65} minSize={20} className="panel">
        <div className="panel-content">Right Panel</div>
      </Panel>
    </Group>
  );
}

export default App;
