import { BasicExample, BashExample } from "./components";
import "./App.css";

export default function App() {
  return (
    <div>
      <h1>Sandlot Examples</h1>
      <div className="examples-grid">
        <BasicExample />
        <BashExample />
      </div>
    </div>
  );
}
