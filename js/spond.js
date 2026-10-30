// Eksport til Spond sin sesongplanlegger: regneark med samme kolonner som Spond-malen
// (se arket «FANA» i vinterserie-filen) og en vanlig kalenderfil (.ics) som alternativ.

const CLUB = "Fana G2014";
const DEFAULT_MINUTES = 75; // kamplengde når sluttid mangler

export const SPOND_HEADER = ["Startdato*", "Starttidspunkt", "Oppmøte", "Sluttdato", "Sluttidspunkt",
  "Kamptype*", "Hjemmelag*", "Bortelag*", "Beskrivelse", "Sted"];

function addMinutes(time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

const endOf = (m) => m.endTime || (m.time ? addMinutes(m.time, DEFAULT_MINUTES) : "");
const ownTeam = (m) => `${CLUB} ${m.team}`;
const homeTeam = (m) => (m.homeAway === "Borte" ? m.opponent : ownTeam(m));
const awayTeam = (m) => (m.homeAway === "Borte" ? ownTeam(m) : m.opponent);

export function spondRows(matches) {
  return [SPOND_HEADER, ...matches.map((m) => {
    const [y, mo, d] = m.date.split("-").map(Number);
    const date = new Date(y, mo - 1, d);
    return [date, m.time || "", m.meetTime || "", date, endOf(m),
      m.type || "Seriekamp", homeTeam(m), awayTeam(m), m.notes || "", m.venue || ""];
  })];
}

// ---- iCalendar ----
const icsEscape = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const icsDateTime = (date, time) => `${date.replace(/-/g, "")}T${(time || "00:00").replace(":", "")}00`;

const OSLO_TZ = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Oslo",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
  "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
  "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE"
];

export function toIcs(matches) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const events = matches.flatMap((m) => {
    const desc = [m.meetTime && `Oppmøte ${m.meetTime}`, m.type, m.notes].filter(Boolean).join("\n");
    return [
      "BEGIN:VEVENT",
      `UID:${m.id}@fanakamper`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Oslo:${icsDateTime(m.date, m.time)}`,
      `DTEND;TZID=Europe/Oslo:${icsDateTime(m.date, endOf(m) || m.time)}`,
      `SUMMARY:${icsEscape(`${homeTeam(m)} – ${awayTeam(m)}`)}`,
      m.venue ? `LOCATION:${icsEscape(m.venue)}` : null,
      desc ? `DESCRIPTION:${icsEscape(desc)}` : null,
      "END:VEVENT"
    ].filter(Boolean);
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fana G2014//Kamper//NO", "CALSCALE:GREGORIAN",
    ...OSLO_TZ, ...events, "END:VCALENDAR"].join("\r\n");
}
