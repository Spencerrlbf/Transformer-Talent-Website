import net from "node:net";
net.Socket.prototype.connect = () => {
  throw Error("unexpected_network_effect");
};
globalThis.fetch = () => {
  throw Error("unexpected_network_effect");
};
