import { z } from "zod";

export const leadProfiles = ["generic", "msp", "si", "event_planner"] as const;

export const LeadProfileSchema = z.enum(leadProfiles);

export type LeadProfile = z.infer<typeof LeadProfileSchema>;

const profileKeywordsByType: Record<LeadProfile, string[]> = {
  generic: ["contact", "services", "quote", "consulting"],
  msp: [
    "managed services",
    "managed service provider",
    "msp",
    "it support",
    "help desk",
    "cybersecurity",
    "microsoft 365",
    "azure",
    "cloud services",
    "vcio"
  ],
  si: [
    "systems integrator",
    "system integrator",
    "implementation",
    "consulting",
    "automation",
    "integration",
    "digital transformation",
    "solution provider",
    "microsoft partner",
    "cloud migration"
  ],
  event_planner: [
    "event planning",
    "wedding planning",
    "corporate events",
    "production",
    "proposal",
    "quote",
    "packages",
    "book a consultation"
  ]
};

export function getProfileKeywords(profile: LeadProfile): string[] {
  return profileKeywordsByType[profile];
}
