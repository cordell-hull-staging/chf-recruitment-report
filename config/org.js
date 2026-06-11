/**
 * Organization Configuration
 *
 * This file contains all organization-specific constants for the Cordell Hull Foundation.
 * Update these values to customize the PDF header and branding.
 */

export const ORG_CONFIG = {
  // Organization name (appears in PDF header)
  name: 'Cordell Hull Foundation',

  // Logo path (relative to project root)
  logoPath: './assets/logo.jpeg',

  // Header image for PDF first page (decorative header)
  headerImagePath: './assets/header.jpeg',

  // Address block (each line is an array element)
  address: [
    '45 Rockefeller Plaza, Floor 20',
    'New York, NY 10111'
  ],

  // Contact information
  website: 'www.cordell-hull.org',

  // PDF Document settings
  pdf: {
    title: 'Cultural Activities Annual Report (J-1 Teacher)',
    author: 'Cordell Hull Foundation',
    subject: 'J-1 Teacher Cultural Exchange Program Annual Report',

    // Colors (RGB 0-1 scale for pdf-lib)
    colors: {
      primary: { r: 0.15, g: 0.30, b: 0.55 },      // Navy blue
      secondary: { r: 0.40, g: 0.40, b: 0.40 },    // Dark gray
      accent: { r: 0.20, g: 0.50, b: 0.30 },       // Forest green
      lightGray: { r: 0.90, g: 0.90, b: 0.90 },    // Light gray for backgrounds
      text: { r: 0.10, g: 0.10, b: 0.10 }          // Near black for body text
    },

    // Margins in points (72 points = 1 inch)
    margins: {
      top: 50,
      bottom: 50,
      left: 50,
      right: 50
    },

    // Font sizes in points
    fonts: {
      title: 20,
      heading: 14,
      subheading: 12,
      body: 10,
      caption: 9,
      small: 8
    }
  }
};

export default ORG_CONFIG;
