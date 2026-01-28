import { BasicExample, BashExample, IframeExample, SharedModulesExample, ShadcnExample } from "./components";
import "./App.css";

export default function App() {
  return (
    <div>
      <h1>Sandlot Examples</h1>
      <div className="examples-grid">
        <BasicExample />
        <SharedModulesExample />
        <ShadcnExample />
        <IframeExample />
        <BashExample />
      </div>
    </div>
  );
}
