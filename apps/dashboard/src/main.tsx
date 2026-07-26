import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastContainer } from "react-toastify";
import { App } from "./App";
import "react-toastify/dist/ReactToastify.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <ToastContainer
      position="bottom-right"
      autoClose={4200}
      newestOnTop
      closeOnClick
      pauseOnHover
      theme="dark"
      toastClassName="sentinel-toast"
    />
  </StrictMode>,
);
