"use strict";
// Usage: npm run resolve-file -- "<OneDrive or SharePoint sharing link to the Excel file>"
// Prints the EXCEL_DRIVE_ID and EXCEL_ITEM_ID values to put in your settings.
const graph = require("../src/graph");

(async () => {
  const link = process.argv[2];
  if (!link) { console.error('Give the sharing link, for example: npm run resolve-file -- "https://contoso-my.sharepoint.com/:x:/g/personal/..."'); process.exit(1); }
  const id = "u!" + Buffer.from(link).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  try {
    const item = await graph.get(`/shares/${id}/driveItem?$select=id,name,webUrl,parentReference`);
    console.log(`File: ${item.name}\nURL:  ${item.webUrl}\n\nAdd these to your settings:\nEXCEL_DRIVE_ID=${item.parentReference.driveId}\nEXCEL_ITEM_ID=${item.id}`);
  } catch (e) {
    console.error("Could not resolve the link:", e.message);
    console.error("Check that the app registration has admin consent for Files.ReadWrite.All (or Sites.Selected with access to this site).");
    process.exit(1);
  }
})();
