import { BasicExample, BashExample, IframeExample } from "./components";
import "./App.css";

export default function App() {
  return (
    <div>
      <h1>Sandlot Examples</h1>
      <div className="examples-grid">
        <BasicExample />
        <IframeExample />
        <BashExample />
      </div>
    </div>
  );
}
