import * as React from 'react';

const tokens = {
  primaryColor: '#3498db',
  secondaryColor: '#2ecc71',
  textColor: '#ecf0f1',
  backgroundColor: '#bdc3c7'
};

export const Styled = ({ children }: { children?: React.ReactNode }) => {
  return (
    <React.Fragment>
      <style jsx global>{`
        :root {
          --primary-color: ${tokens.primaryColor};
          --secondary-color: ${tokens.secondaryColor};
          --text-color: ${tokens.textColor};
          --background-color: ${tokens.backgroundColor};
        }

        body {
          margin: 0;
          padding: 0;
          font-family: Arial, sans-serif;
          background-color: var(--background-color);
          color: var(--text-color);
        }
      `}</style>
      {children}
    </React.Fragment>
  );
};
