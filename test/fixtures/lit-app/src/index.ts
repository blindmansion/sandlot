import "./app-root";

const mount = document.querySelector("#app");
if (mount) {
	mount.appendChild(document.createElement("app-root"));
}
