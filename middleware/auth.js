function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const redirectURL = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?redirectURL=${redirectURL}`);
}

module.exports = { isAuthenticated };
