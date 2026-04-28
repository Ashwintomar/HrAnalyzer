// WebGPU ONNX Runtime Optimization Tips and Performance Monitor
// Helps understand and optimize WebGPU performance for embedding models

class WebGPUOptimizationMonitor {
    constructor() {
        this.performanceData = {
            inferences: [],
            averageTime: 0,
            webgpuUsage: 0,
            warnings: []
        };
        
        this.optimizationTips = {
            nodeAssignmentWarnings: {
                explanation: "Some nodes not assigned to WebGPU is NORMAL and expected behavior.",
                details: [
                    "Shape-related operations are intentionally kept on CPU for better performance",
                    "Data type conversions often stay on CPU",
                    "Small operations may be more efficient on CPU",
                    "This doesn't indicate a problem with your WebGPU setup"
                ],
                impact: "Minimal - ONNX Runtime automatically optimizes execution placement"
            },
            
            modelOptimizations: {
                bgeSeries: {
                    "bge-small-en-v1.5": {
                        expectedWebGPUNodes: "~85-90%",
                        typicalCPUNodes: ["Shape", "Gather", "Cast", "Reshape", "Transpose"],
                        optimizations: [
                            "Use FP16 models when available for better WebGPU performance",
                            "Batch multiple texts together when possible",
                            "Consider model quantization for production deployments"
                        ]
                    },
                    "bge-base-en-v1.5": {
                        expectedWebGPUNodes: "~88-92%",
                        typicalCPUNodes: ["Shape", "Gather", "Cast", "Reshape", "Transpose"],
                        optimizations: [
                            "Larger model benefits more from WebGPU acceleration",
                            "Use dynamic batching for variable input lengths",
                            "Monitor memory usage for large batches"
                        ]
                    }
                }
            },
            
            browserOptimizations: {
                chrome: [
                    "Enable --enable-unsafe-webgpu flag",
                    "Use --enable-features=Vulkan on Linux",
                    "Keep browser updated (113+ required)"
                ],
                edge: [
                    "Enable WebGPU in edge://flags",
                    "Ensure latest WebView2 runtime",
                    "Check Windows GPU drivers"
                ],
                safari: [
                    "Requires macOS 15+ for full support",
                    "Enable WebGPU in Safari Technology Preview",
                    "Check GPU compatibility"
                ],
                firefox: [
                    "Set dom.webgpu.enabled=true in about:config",
                    "Use Firefox Nightly for best support",
                    "Enable WebGPU experimental features"
                ]
            }
        };
    }

    recordInference(startTime, endTime, provider, success = true, warnings = []) {
        const duration = endTime - startTime;
        
        this.performanceData.inferences.push({
            timestamp: Date.now(),
            duration,
            provider,
            success,
            warnings: warnings.map(w => w.message || w)
        });

        // Keep only last 100 inferences
        if (this.performanceData.inferences.length > 100) {
            this.performanceData.inferences = this.performanceData.inferences.slice(-100);
        }

        this.updateAverages();
        this.categorizeWarnings(warnings);

        return {
            duration,
            provider,
            isOptimal: duration < this.getExpectedTime(provider),
            recommendations: this.getPerformanceRecommendations(provider, duration)
        };
    }

    updateAverages() {
        const recent = this.performanceData.inferences.slice(-20); // Last 20 inferences
        
        if (recent.length === 0) return;

        this.performanceData.averageTime = recent.reduce((sum, inf) => sum + inf.duration, 0) / recent.length;
        
        const webgpuInferences = recent.filter(inf => inf.provider === 'webgpu');
        this.performanceData.webgpuUsage = (webgpuInferences.length / recent.length) * 100;
    }

    categorizeWarnings(warnings) {
        for (const warning of warnings) {
            const message = warning.message || warning;
            
            if (message.includes('not assigned to the preferred execution providers')) {
                this.performanceData.warnings.push({
                    type: 'node_assignment',
                    severity: 'info',
                    message: message,
                    explanation: this.optimizationTips.nodeAssignmentWarnings.explanation,
                    action: 'none_required'
                });
            } else if (message.includes('memory')) {
                this.performanceData.warnings.push({
                    type: 'memory',
                    severity: 'warning',
                    message: message,
                    action: 'reduce_batch_size_or_check_gpu_memory'
                });
            } else {
                this.performanceData.warnings.push({
                    type: 'other',
                    severity: 'info',
                    message: message,
                    action: 'monitor'
                });
            }
        }

        // Keep only unique warnings and last 50
        const uniqueWarnings = this.performanceData.warnings.filter((warning, index, self) => 
            index === self.findIndex(w => w.message === warning.message)
        );
        this.performanceData.warnings = uniqueWarnings.slice(-50);
    }

    getExpectedTime(provider) {
        // Expected inference times in ms for typical embedding generation
        const expectedTimes = {
            webgpu: 50,    // Fast GPU inference
            wasm: 150,     // WASM with SIMD
            cpu: 300       // Basic CPU inference
        };
        
        return expectedTimes[provider] || expectedTimes.cpu;
    }

    getPerformanceRecommendations(provider, duration) {
        const recommendations = [];
        const expectedTime = this.getExpectedTime(provider);

        if (duration > expectedTime * 2) {
            recommendations.push({
                type: 'performance',
                priority: 'high',
                message: `Inference took ${duration.toFixed(2)}ms, expected ~${expectedTime}ms for ${provider}`,
                suggestions: [
                    'Check if model is properly loaded',
                    'Verify WebGPU is actually being used',
                    'Consider smaller batch size',
                    'Check system resources (GPU memory, CPU usage)'
                ]
            });
        }

        if (provider !== 'webgpu' && typeof navigator.gpu !== 'undefined') {
            recommendations.push({
                type: 'provider',
                priority: 'medium',
                message: `Using ${provider} instead of WebGPU`,
                suggestions: [
                    'Check WebGPU availability',
                    'Verify browser flags are enabled',
                    'Check GPU driver compatibility'
                ]
            });
        }

        return recommendations;
    }

    generateReport() {
        const report = {
            summary: {
                totalInferences: this.performanceData.inferences.length,
                averageTime: this.performanceData.averageTime.toFixed(2),
                webgpuUsagePercent: this.performanceData.webgpuUsage.toFixed(1),
                uniqueWarnings: this.performanceData.warnings.length
            },
            performance: {
                recentInferences: this.performanceData.inferences.slice(-10),
                providerDistribution: this.getProviderDistribution(),
                performanceTrend: this.getPerformanceTrend()
            },
            warnings: {
                nodeAssignmentInfo: this.optimizationTips.nodeAssignmentWarnings,
                recentWarnings: this.performanceData.warnings.slice(-10),
                warningsSummary: this.getWarningsSummary()
            },
            optimizations: this.optimizationTips,
            timestamp: new Date().toISOString()
        };

        return report;
    }

    getProviderDistribution() {
        const distribution = {};
        
        for (const inference of this.performanceData.inferences) {
            distribution[inference.provider] = (distribution[inference.provider] || 0) + 1;
        }
        
        return distribution;
    }

    getPerformanceTrend() {
        if (this.performanceData.inferences.length < 10) {
            return 'insufficient_data';
        }

        const recent = this.performanceData.inferences.slice(-10);
        const older = this.performanceData.inferences.slice(-20, -10);

        if (older.length === 0) return 'stable';

        const recentAvg = recent.reduce((sum, inf) => sum + inf.duration, 0) / recent.length;
        const olderAvg = older.reduce((sum, inf) => sum + inf.duration, 0) / older.length;

        const improvementPercent = ((olderAvg - recentAvg) / olderAvg) * 100;

        if (improvementPercent > 10) return 'improving';
        if (improvementPercent < -10) return 'degrading';
        return 'stable';
    }

    getWarningsSummary() {
        const summary = {};
        
        for (const warning of this.performanceData.warnings) {
            summary[warning.type] = (summary[warning.type] || 0) + 1;
        }
        
        return summary;
    }

    displayOptimizationTips() {
        // Only show tips in development mode or if there are performance issues
        const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const hasPerformanceIssues = this.performanceData.averageTime > 200; // Only if slow
        
        if (isDev && hasPerformanceIssues) {
            console.group('� WebGPU Performance Tips');
            console.log('ℹ️ Node assignment warnings are normal - some ops run better on CPU');
            console.log('📊 Use window.webgpuOptimizationMonitor.generateReport() for detailed diagnostics');
            console.groupEnd();
        }
        
        // Always provide silent access to tips via the global object
        // Users can call window.webgpuOptimizationMonitor.generateReport() for full details
    }
}

// Global instance
window.webgpuOptimizationMonitor = new WebGPUOptimizationMonitor();

// Auto-initialize monitor on load (silent)
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        // Monitor is ready but doesn't auto-display tips
        // Call window.webgpuOptimizationMonitor.generateReport() for diagnostics
        console.log('⚙️ WebGPU Monitor ready. Use webgpuOptimizationMonitor.generateReport() for detailed diagnostics.');
    });
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WebGPUOptimizationMonitor;
}