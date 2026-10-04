import type { Marker, Order } from "../model.js"

// Fictional demonstration measurements, never clinical advice or patient data.
type Sample = [
  name: string,
  value: number,
  unit: string,
  low: number,
  high: number,
  previous: number,
]
const PANELS: Record<string, Sample[]> = {
  "Basic Metabolic Panel": [
    ["Glucose", 92, "mg/dL", 70, 99, 96],
    ["Calcium", 9.4, "mg/dL", 8.6, 10.2, 9.2],
    ["Sodium", 140, "mmol/L", 135, 145, 139],
    ["Potassium", 4.2, "mmol/L", 3.5, 5.1, 4.1],
    ["Chloride", 102, "mmol/L", 98, 107, 103],
    ["CO₂", 25, "mmol/L", 22, 29, 24],
    ["BUN", 14, "mg/dL", 7, 20, 16],
    ["Creatinine", 0.9, "mg/dL", 0.6, 1.3, 0.95],
  ],
  "Complete Blood Count": [
    ["White blood cells", 6.4, "10³/µL", 4, 11, 6.8],
    ["Red blood cells", 4.8, "10⁶/µL", 4.2, 5.9, 4.7],
    ["Hemoglobin", 14.2, "g/dL", 12, 17.5, 14],
    ["Hematocrit", 43, "%", 36, 53, 42],
    ["Platelets", 245, "10³/µL", 150, 400, 238],
  ],
  "Lipid Panel": [
    ["Total cholesterol", 208, "mg/dL", 100, 199, 218],
    ["LDL", 132, "mg/dL", 0, 99, 141],
    ["HDL", 58, "mg/dL", 40, 100, 54],
    ["Triglycerides", 90, "mg/dL", 0, 149, 115],
  ],
  HbA1c: [["HbA1c", 5.3, "%", 4, 5.6, 5.5]],
  "Thyroid Panel": [
    ["TSH", 2.1, "mIU/L", 0.4, 4, 2.4],
    ["Free T3", 3.2, "pg/mL", 2.3, 4.2, 3.1],
    ["Free T4", 1.2, "ng/dL", 0.8, 1.8, 1.1],
  ],
  "Testosterone, Total": [["Testosterone", 480, "ng/dL", 300, 1000, 465]],
}
export const sampleResults = (names: string[]): Order["results"] =>
  names.map((panel) => ({
    panel,
    markers: (PANELS[panel] ?? []).map(
      ([name, value, unit, low, high, previous]): Marker => ({
        name,
        value,
        unit,
        low,
        high,
        previous,
        flag: value < low ? "low" : value > high ? "high" : "normal",
      }),
    ),
  }))
