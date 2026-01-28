import { BasicExample, BashExample, IframeExample, SharedModulesExample } from "./components";
import "./App.css";

export default function App() {
  return (
    <div>
      <h1>Sandlot Examples</h1>
      <div className="examples-grid">
        <BasicExample />
        <SharedModulesExample />
        <IframeExample />
        <BashExample />
      </div>
    </div>
  );
}
