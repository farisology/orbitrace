// Invented secrets for the history store tests (#25). None is real. Each is assembled at run time
// from pieces, so no source line contains a string in a real key format (and `npm run privacy`,
// which looks for such strings, passes). Each has a distinctive body so a test can look for it in
// the raw bytes of the database.

const join = (...parts: string[]): string => parts.join("");
const dashes = "-".repeat(5);

const keyBody = join("MIIfake", "KeyBody", "Zx9".repeat(8));
const privateKeyHead = join(dashes, "BEGIN ", "RSA ", "PRIVATE ", "KEY", dashes);
const privateKeyTail = join(dashes, "END ", "RSA ", "PRIVATE ", "KEY", dashes);
const urlPassword = join("s3cret", "Pass", "Word77");

export const FAKE = {
  tokens: {
    anthropic: join("sk", "-ant-", "api03-", "Qw7".repeat(10)),
    openai: join("sk", "-proj-", "Rt5".repeat(10)),
    github: join("gh", "p_", "A1b2".repeat(9)),
    gitlab: join("gl", "pat-", "Hj4".repeat(8)),
    aws: join("AK", "IA", "FAKEKEY0FAKEKEY0"),
    slack: join("xo", "xb-", "123456-", "Lm3".repeat(6)),
    google: join("AI", "za", "Sy", "Ff6".repeat(11)),
    stripe: join("sk", "_live_", "Np8".repeat(8)),
    digitalocean: join("do", "p_v1_", "c0ffee".repeat(6)),
    npm: join("np", "m_", "Vb2".repeat(12)),
    huggingface: join("h", "f_", "Kd5".repeat(11)),
    jwt: join("ey", "J", "hbGciOiJIUzI1", ".", "ey", "J", "zdWIiOiJmYWtl", ".", "Sig9".repeat(4)),
  },
  keyBody,
  privateKeyHead,
  privateKey: join(privateKeyHead, "\n", keyBody, "\n", privateKeyTail),
  urlPassword,
  urlWithCredentials: join("postgres://", "example-user:", urlPassword, "@", "db.example.com/app"),
  bearer: join("bearer", "Tok", "9f8e7d6c5b4a"),
  basic: join("ZXhhbXBsZS", "11c2VyOmZha2U", "="),
  password: join("hunter", "2-", "fake-", "pw42"),
} as const;

/** The distinctive part of every planted secret: none may appear in the stored bytes. */
export function plantedMarkers(): readonly string[] {
  return [
    ...Object.values(FAKE.tokens),
    FAKE.keyBody,
    FAKE.urlPassword,
    FAKE.bearer,
    FAKE.basic,
    FAKE.password,
  ];
}
