import React from 'react';

const GridDisplay: React.FC = () => {
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'repeat(5, auto)', gap: '10px' }}>
      {/* Content goes here */}
    </div>
  );
};

export default GridDisplay;