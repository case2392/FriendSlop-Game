// (test only)
// Wire format between fake-Steam clients and the fake-Steam backend (a stand-in for the Steam client +
// Valve's relay network). Length-prefixed frames over TCP: [u32 len][u8 op][payload].
export const OP = {
  // client -> backend
  REGISTER: 1, SEND: 2, ACCEPT: 3, CREATE_LOBBY: 4, JOIN_LOBBY: 5, LEAVE_LOBBY: 6, SET_LOBBY_DATA: 7,
  SET_JOINABLE: 8, INVITE: 9, RICH_PRESENCE: 10, CONTROL: 11,
  // backend -> client
  PKT: 101, SESSION_REQUEST: 102, SESSION_FAIL: 103, LOBBY_RESULT: 104, LOBBY_STATE: 105,
  LOBBY_CHAT_UPDATE: 106, LOBBY_DATA_UPDATE: 107, JOIN_REQUESTED: 108, CONTROL_RESULT: 109, REGISTERED: 110,
};

export function frame(op, payload = Buffer.alloc(0)) {
  const b = Buffer.allocUnsafe(5 + payload.length);
  b.writeUInt32LE(1 + payload.length, 0); b[4] = op; payload.copy(b, 5);
  return b;
}
export const jframe = (op, obj) => frame(op, Buffer.from(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v))));

// incremental decoder for a TCP stream
export function decoder(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const op = buf[4], payload = buf.subarray(5, 4 + n);
      buf = buf.subarray(4 + n);
      onFrame(op, payload);
    }
  };
}
export const json = payload => JSON.parse(payload.toString());
