process.env.HR_ANALYZER_DESKTOP = process.env.HR_ANALYZER_DESKTOP || '1';
process.env.DISABLE_AUTO_OPEN = process.env.DISABLE_AUTO_OPEN || '1';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.PORT = process.env.PORT || '3000';

require('../index');
