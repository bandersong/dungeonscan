// DungeonScan — CreateML image classifier trainer (Xcode 26 / CreateML API).
//
// Trains a CoreML image classifier on the synthetic glyph dataset that
// gen_glyphs.py produced, using an explicit stratified train/val split
// (dataset_split/{train,val}) so validation accuracy is measured on ~15%
// held-out data we control.
//
// Run:
//   swift train.swift
//
// Writes models/DungeonCellClassifier.mlmodel (falls back to .mlpackage on
// toolchains that only ship the package format) and prints full metrics.

import CreateML
import CoreML
import Foundation

let root       = "/Users/creative/DungeonScan"
let modelsDir  = URL(fileURLWithPath: "\(root)/models")

func env(_ k: String, _ d: String) -> String {
    ProcessInfo.processInfo.environment[k] ?? d
}
let trainURL = URL(fileURLWithPath: env("DS_TRAIN_DIR", "\(root)/training/dataset_split/train"))
let valURL   = URL(fileURLWithPath: env("DS_VAL_DIR",   "\(root)/training/dataset_split/val"))

@inline(__always) func acc(_ classificationError: Double) -> Double {
    return 1.0 - classificationError
}

// Discover class labels from the train directory (sorted) — matches labels.json.
let labels: [String] = {
    let fm = FileManager.default
    guard let dirs = try? fm.contentsOfDirectory(at: trainURL, includingPropertiesForKeys: [.isDirectoryKey]) else {
        return []
    }
    return dirs.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
               .map { $0.lastPathComponent }
               .sorted()
}()

do {
    print("Train dir: \(trainURL.path)")
    print("Val   dir: \(valURL.path)")

    let trainSrc = MLImageClassifier.DataSource.labeledDirectories(at: trainURL)
    let valSrc   = MLImageClassifier.DataSource.labeledDirectories(at: valURL)

    // Modern (non-deprecated) CreateML API on Xcode 26: feature extractor +
    // head live behind `algorithm`. scenePrint(revision: 2) is the latest
    // Vision scene-print feature extractor; logisticRegressor is the classic
    // fast linear head on top of those features.
    let params = MLImageClassifier.ModelParameters(
        validation: .dataSource(valSrc),
        maxIterations: 40,
        augmentation: [.crop, .rotation, .blur, .noise],
        algorithm: .transferLearning(
            featureExtractor: .scenePrint(revision: 2),
            classifier: .logisticRegressor
        )
    )

    print("Training: scenePrint(rev2) + logisticRegressor, maxIterations=40, "
          + "augmentation=[crop,rotation,blur,noise] …")
    let model = try MLImageClassifier(trainingData: trainSrc, parameters: params)

    let trErr = model.trainingMetrics.classificationError
    let vaErr = model.validationMetrics.classificationError
    print(String(format: "Training accuracy:   %.4f", acc(trErr)))
    print(String(format: "Validation accuracy: %.4f", acc(vaErr)))

    // Confusion matrix on the validation set — shows which classes confuse.
    print("\n----- VALIDATION CONFUSION (rows = true class, cols = predicted) -----")
    print(model.validationMetrics.confusionDataFrame)
    print("\n----- VALIDATION PRECISION / RECALL -----")
    print(model.validationMetrics.precisionRecallDataFrame)

    print("\nClass labels (\(labels.count)): \(labels.joined(separator: ", "))")

    // Persist. Prefer the flat .mlmodel bundle; newer toolchains may require
    // .mlpackage. Both compile to .mlmodelc identically via coremlcompiler.
    let mlmodelURL   = modelsDir.appendingPathComponent("DungeonCellClassifier.mlmodel")
    let mlpackageURL = modelsDir.appendingPathComponent("DungeonCellClassifier.mlpackage")
    let modelURL: URL
    do {
        try model.write(to: mlmodelURL)
        modelURL = mlmodelURL
        print("Wrote \(mlmodelURL.path)")
    } catch {
        print("(.mlmodel write unavailable: \(error.localizedDescription); writing .mlpackage)")
        try model.write(to: mlpackageURL)
        modelURL = mlpackageURL
        print("Wrote \(mlpackageURL.path)")
    }
    print("\nDONE -> \(modelURL.path)")
} catch {
    print("FATAL: \(error)")
    exit(1)
}
