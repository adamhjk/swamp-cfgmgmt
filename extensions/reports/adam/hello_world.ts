export const report = {
  name: "@adam/hello-world",
  description: "ASCII cat says hello world",
  scope: "method",
  labels: ["hello-world"],
  execute: (_context) => {
    const cat = [
      "  /\\_/\\  ",
      " ( o.o ) ",
      "  > ^ <  ",
      " /|   |\\",
      "(_|   |_)",
    ].join("\n");

    const markdown = [
      "## Hello World!",
      "",
      "```",
      cat,
      "```",
      "",
    ].join("\n");

    return { markdown, json: { message: "hello world", cat } };
  },
};
