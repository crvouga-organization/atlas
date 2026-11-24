/** Parse a large report away from the UI thread. The caller transfers ownership of its response buffer. */
self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try { self.postMessage({ value: JSON.parse(new TextDecoder().decode(event.data)) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
