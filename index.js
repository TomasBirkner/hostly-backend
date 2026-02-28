const express = require("express");
const cors = require("cors");
const ical = require("node-ical");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── In-memory cache of parsed reservations ────────────────────────────────
// Structure: { propertyId: { icalUrl, name, reservations, lastSynced } }
let propertyCache = {};

// ─── Parse iCal feed into reservation objects ──────────────────────────────
async function parseIcal(icalUrl, propertyId, propertyName) {
  try {
    const events = await ical.async.fromURL(icalUrl);
    const reservations = [];

    for (const key in events) {
      const event = events[key];
      if (event.type !== "VEVENT") continue;

      // Airbnb uses SUMMARY like "Reserved - Airbnb (HMXXXXXX)"
      // Blocked dates have summary "Airbnb (Not available)"
      const summary = event.summary || "";
      const isBlocked =
        summary.toLowerCase().includes("not available") ||
        summary.toLowerCase().includes("airbnb") && !summary.toLowerCase().includes("reserved");

      if (isBlocked) continue; // skip blocked/unavailable dates

      const checkIn = event.start ? new Date(event.start) : null;
      const checkOut = event.end ? new Date(event.end) : null;

      if (!checkIn || !checkOut) continue;

      // Extract guest name from summary (format: "Reserved - Airbnb (HMXXXXXXXX)")
      // or just use "Airbnb Guest" as fallback
      let guestName = "Airbnb Guest";
      const reservedMatch = summary.match(/reserved\s*[-–]\s*(.+)/i);
      if (reservedMatch) {
        guestName = reservedMatch[1].trim();
      } else if (event.description) {
        // Sometimes guest name is in description
        const descMatch = event.description.match(/(?:guest|name):\s*(.+)/i);
        if (descMatch) guestName = descMatch[1].trim();
      }

      const nights = Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));

      reservations.push({
        id: event.uid || `${propertyId}-${checkIn.toISOString()}`,
        propertyId,
        guestName,
        checkIn: checkIn.toISOString().split("T")[0],
        checkOut: checkOut.toISOString().split("T")[0],
        nights,
        total: 0, // Airbnb iCal doesn't include pricing
        source: "airbnb",
        summary,
      });
    }

    return reservations;
  } catch (err) {
    console.error(`Error parsing iCal for property ${propertyId}:`, err.message);
    return null;
  }
}

// ─── Sync all registered properties ────────────────────────────────────────
async function syncAll() {
  console.log(`[${new Date().toISOString()}] Syncing all properties...`);
  for (const propertyId in propertyCache) {
    const entry = propertyCache[propertyId];
    const reservations = await parseIcal(entry.icalUrl, propertyId, entry.name);
    if (reservations !== null) {
      propertyCache[propertyId].reservations = reservations;
      propertyCache[propertyId].lastSynced = new Date().toISOString();
      console.log(`  ✓ ${entry.name}: ${reservations.length} reservations`);
    } else {
      console.log(`  ✗ ${entry.name}: sync failed`);
    }
  }
}

// ─── Auto-sync every hour ──────────────────────────────────────────────────
cron.schedule("0 * * * *", syncAll);

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Hostly iCal Sync Backend", version: "1.0.0" });
});

// Register or update a property's iCal URL
// POST /properties { propertyId, name, icalUrl }
app.post("/properties", async (req, res) => {
  const { propertyId, name, icalUrl } = req.body;

  if (!propertyId || !icalUrl) {
    return res.status(400).json({ error: "propertyId and icalUrl are required" });
  }

  if (!icalUrl.startsWith("https://")) {
    return res.status(400).json({ error: "icalUrl must be a valid https:// URL" });
  }

  // Register property
  propertyCache[propertyId] = {
    icalUrl,
    name: name || `Property ${propertyId}`,
    reservations: propertyCache[propertyId]?.reservations || [],
    lastSynced: null,
  };

  // Immediately sync this property
  const reservations = await parseIcal(icalUrl, propertyId, name);
  if (reservations !== null) {
    propertyCache[propertyId].reservations = reservations;
    propertyCache[propertyId].lastSynced = new Date().toISOString();
    res.json({
      success: true,
      propertyId,
      name,
      reservationCount: reservations.length,
      lastSynced: propertyCache[propertyId].lastSynced,
    });
  } else {
    res.status(500).json({ error: "Failed to fetch or parse iCal URL. Please check the URL and try again." });
  }
});

// Get all synced reservations (optionally filter by propertyId)
// GET /reservations?propertyId=1
app.get("/reservations", (req, res) => {
  const { propertyId } = req.query;

  let allReservations = [];
  let syncStatus = [];

  for (const pid in propertyCache) {
    const entry = propertyCache[pid];
    syncStatus.push({
      propertyId: pid,
      name: entry.name,
      lastSynced: entry.lastSynced,
      reservationCount: entry.reservations.length,
    });

    if (!propertyId || pid === propertyId) {
      allReservations = allReservations.concat(entry.reservations);
    }
  }

  res.json({
    reservations: allReservations,
    syncStatus,
    totalProperties: Object.keys(propertyCache).length,
  });
});

// Manually trigger a sync for all properties
// POST /sync
app.post("/sync", async (req, res) => {
  await syncAll();
  const syncStatus = Object.entries(propertyCache).map(([pid, entry]) => ({
    propertyId: pid,
    name: entry.name,
    lastSynced: entry.lastSynced,
    reservationCount: entry.reservations.length,
  }));
  res.json({ success: true, syncStatus });
});

// Reset all properties
app.post("/reset", (req, res) => {
  propertyCache = {};
  res.json({ success: true, message: "All properties cleared" });
});

// Remove a property
// DELETE /properties/:propertyId
app.delete("/properties/:propertyId", (req, res) => {
  const { propertyId } = req.params;
  if (propertyCache[propertyId]) {
    delete propertyCache[propertyId];
    res.json({ success: true, message: `Property ${propertyId} removed` });
  } else {
    res.status(404).json({ error: "Property not found" });
  }
});

// Get registered properties
// GET /properties
app.get("/properties", (req, res) => {
  const properties = Object.entries(propertyCache).map(([pid, entry]) => ({
    propertyId: pid,
    name: entry.name,
    lastSynced: entry.lastSynced,
    reservationCount: entry.reservations.length,
  }));
  res.json({ properties });
});

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🏠 Hostly Backend running on port ${PORT}`);
  console.log(`   Sync schedule: every hour`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /reservations`);
  console.log(`     POST /properties`);
  console.log(`     POST /sync`);
});
