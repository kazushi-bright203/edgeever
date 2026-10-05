// Wrangler can exit successfully while reporting that no account is logged in.
export const isCloudflareAuthenticated = (result) => result.status === 0
  && /you are (?:logged in|authenticated)\b/i.test(String(result.stdout ?? ""))
  && !/not authenticated|not logged in/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
