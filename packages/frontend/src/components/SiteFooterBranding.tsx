import React from "react";

interface SiteFooterBrandingProps {
  siteName: string;
  copyrightNotice: string;
}

const SiteFooterBranding: React.FC<SiteFooterBrandingProps> = ({ siteName, copyrightNotice }) => (
  <>
    <div>
      {siteName} Powered by{" "}
      <a href="https://github.com/houyhlouis/LLMOJ" target="_blank" rel="noreferrer noopener">
        LLMOJ
      </a>
    </div>
    {copyrightNotice?.trim() && copyrightNotice !== "LLMOJ" && copyrightNotice !== "LibreOJ Open Source Project" && (
      <div>{copyrightNotice}</div>
    )}
  </>
);

export default SiteFooterBranding;
